import EventEmitter from 'events';
import Subscription from './subscription';

import { SockjsTransport } from './transport_sockjs';
import { WebsocketTransport } from './transport_websocket';
import { HttpStreamTransport } from './transport_http_stream';
import { SseTransport } from './transport_sse';

// Rework error objects.
// Think more about disconnect/close reasons and contexts.
// Rename presence->presence to presence->clients?
// Typed EventEmitter? https://github.com/andywer/typed-emitter
// Disconnect on unsubscribe command failure.
// Decide on disconnect fire on first transport error. Maybe 'error' event + connected() promise?

import {
  JsonEncoder,
  JsonDecoder
} from './json';

import {
  isFunction,
  log,
  startsWith,
  errorExists,
  backoff,
  extend,
  ttlMilliseconds
} from './utils';

const states = {
  // Initial state, state when connection explicitly disconnected.
  DISCONNECTED: 'disconnected',
  // State after connect, state after connection lost, after disconnect with reconnect code.
  CONNECTING: 'connecting',
  // State when connected and authentication passed (connect result received).
  CONNECTED: 'connected',
  // State when client closed. Close can be clean or caused by one of the close reasons.
  CLOSED: 'closed'
};

const closeReasons = {
  // Connection closed by client, server-side subscription position state cleared.
  // Client-side subscriptions registry is untouched and client-side subscriptions
  // position state is not affected.
  CLIENT: 'client',
  // Connection closed by server, all subscription position state kept.
  SERVER: 'server',
  // Fatal error during connect or reconnect, all subscription position state kept.
  CONNECT_FAILED: 'connect failed',
  // Fatal error during token refresh, all subscription position state kept.
  REFRESH_FAILED: 'refresh failed',
  // Access denied, all subscription position state kept.
  UNAUTHORIZED: 'unauthorized',
  // Client was not able to recover server-side subscriptions state. Only server-side
  // subscriptions position state cleared at this point – client-side subscriptions
  // still keep their position state. If client closed due to this reason application
  // must decide what to do: connect from scratch (possibly load initial state from the
  // backend), or do nothing.
  UNRECOVERABLE_POSITION: 'unrecoverable position'
};

export class Centrifuge extends EventEmitter {

  constructor(endpoint, options) {
    super();
    this._endpoint = endpoint;
    this._transports = [];
    this._emulation = false;
    this._currentTransportIndex = 0;
    this._transportWasOpen = false;
    this._lastDisconnectCode = -1;
    this._transport = null;
    this._transportClosed = true;
    this._encoder = null;
    this._decoder = null;
    this._state = states.DISCONNECTED;
    this._reconnectTimeout = null;
    this._commandId = 0;
    this._client = null;
    this._session = '';
    this._node = '';
    this._refreshRequired = false;
    this._subs = {};
    this._serverSubs = {};
    this._commands = [];
    this._isBatching = false;
    this._refreshTimeout = null;
    this._pingTimeout = null;
    this._pongTimeout = null;
    this._reconnectAttempts = 0;
    this._callbacks = {};
    this._latency = null;
    this._latencyStart = null;
    this._token = null;
    this._dispatchPromise = Promise.resolve();
    this._protocol = 'json';
    this._serverPing = 0;
    this._sendPong = false;
    this._serverPingTimeout = null;
    this._promises = {};
    this._promiseId = 0;
    this._config = {
      token: null,
      data: null,
      protocol: 'json',
      debug: false,
      name: 'js',
      version: '',
      fetch: null,
      readableStream: null,
      websocket: null,
      eventsource: null,
      sockjs: null,
      sockjsServer: null,
      sockjsTimeout: null,
      sockjsTransports: [
        'websocket',
        'xdr-streaming',
        'xhr-streaming',
        'eventsource',
        'iframe-eventsource',
        'iframe-htmlfile',
        'xdr-polling',
        'xhr-polling',
        'iframe-xhr-polling',
        'jsonp-polling'
      ],
      httpStreamRequestMode: 'cors',
      emulationEndpoint: '/emulation',
      emulationRequestMode: 'cors',
      minReconnectDelay: 500,
      maxReconnectDelay: 20000,
      timeout: 5000,
      maxServerPingDelay: 10000,
      pingInterval: 25000,
      pongWaitTimeout: 10000,
      privateChannelPrefix: '$',
      getConnectionToken: null,
      getSubscriptionToken: null
    };
    this._configure(options);
  }

  state() {
    return this._state;
  }

  // newSubscription allocates new Subscription to a channel. It throws
  // if client already has channel subscription internally.
  newSubscription(channel, opts) {
    if (this.getSubscription(channel) !== null) {
      throw new Error('Subscription to a channel already exists');
    }
    const sub = new Subscription(this, channel, opts);
    this._subs[channel] = sub;
    return sub;
  }

  // getSubscription returns Subscription if it's registered in internal
  // registry or null.
  getSubscription(channel) {
    return this._getSub(channel);
  }

  // connected returns a Promise which resolves upon client goes to CONNECTED
  // state and rejects in case of client goes to DISCONNECTED or CLOSED state.
  _connected() {
    if (this._state === states.DISCONNECTED || this._state === states.CLOSED) {
      return Promise.reject({ state: this._state });
    };
    if (this._state === states.CONNECTED) {
      return Promise.resolve();
    };
    return new Promise((res, rej) => {
      let ctx = {
        resolve: res,
        reject: rej
      };
      this._promises[this._nextPromiseId()] = ctx;
    });
  }

  connect() {
    if (this._isConnected()) {
      this._debug('connect called when already connected');
      return;
    }
    if (this._isConnecting()) {
      this._debug('connect called when already connecting');
      return;
    }
    this._startConnecting();
  };

  disconnect() {
    this._disconnect(0, 'client disconnect', false, false, false);
  };

  close() {
    this._close(closeReasons.CLIENT, true, false);
  };

  send(data) {
    const cmd = {
      send: {
        data: data
      }
    };

    const self = this;

    return this._methodCall().then(function () {
      const sent = self._transportSendCommands([cmd]); // can send async message to server without id set
      if (!sent) {
        return Promise.reject(self._createErrorObject(2, 'transport write error'));
      };
      return Promise.resolve();
    });
  }

  rpc(method, data) {
    const cmd = {
      rpc: {
        method: method,
        data: data
      }
    };

    const self = this;

    return this._methodCall().then(function () {
      return self._callPromise(cmd, function (reply) {
        return {
          'data': reply.rpc.data
        };
      });
    });
  }

  publish(channel, data) {
    const cmd = {
      publish: {
        channel: channel,
        data: data
      }
    };

    const self = this;

    return this._methodCall().then(function () {
      return self._callPromise(cmd, function () {
        return {};
      });
    });
  }

  history(channel, options) {
    const cmd = {
      history: this._getHistoryRequest(channel, options)
    };

    const self = this;

    return this._methodCall().then(function () {
      return self._callPromise(cmd, function (reply) {
        const result = reply.history;
        const publications = [];
        if (result.publications) {
          for (let i = 0; i < result.publications.length; i++) {
            publications.push(self._getPublicationContext(channel, result.publications[i]));
          }
        }
        return {
          'publications': publications,
          'epoch': result.epoch || '',
          'offset': result.offset || 0
        };
      });
    });
  }

  presence(channel) {
    const cmd = {
      presence: {
        channel: channel
      }
    };

    const self = this;

    return this._methodCall().then(function () {
      return self._callPromise(cmd, function (reply) {
        return {
          'clients': reply.presence.presence
        };
      });
    });
  }

  presenceStats(channel) {
    const cmd = {
      'presence_stats': {
        channel: channel
      }
    };

    const self = this;

    return this._methodCall().then(function () {
      return self._callPromise(cmd, function (reply) {
        const result = reply.presence_stats;
        return {
          'numUsers': result.num_users,
          'numClients': result.num_clients
        };
      });
    });
  }

  startBatching() {
    // start collecting messages without sending them to Centrifuge until flush
    // method called
    this._isBatching = true;
  };

  stopBatching() {
    this._isBatching = false;
    this._flush();
  };

  _log() { log('info', arguments); };

  _debug() {
    if (this._config.debug === true) { log('debug', arguments); }
  };

  _setFormat(format) {
    if (this._formatOverride(format)) {
      return;
    }
    if (format === 'protobuf') {
      throw new Error('not implemented by JSON only Centrifuge client – use client with Protobuf');
    }
    this._encoder = new JsonEncoder();
    this._decoder = new JsonDecoder();
  }

  _formatOverride(format) {
    return false;
  }

  _configure(options) {
    if (!('Promise' in global)) {
      throw new Error('Promise polyfill required');
    }

    extend(this._config, options || {});
    this._debug('centrifuge config', this._config);

    if (!this._endpoint) {
      throw new Error('endpoint configuration required');
    }

    if (this._config.protocol !== 'json' && this._config.protocol !== 'protobuf') {
      throw new Error('unsupported protocol ' + this._config.protocol);
    }

    if (this._config.token !== null) {
      this._token = this._config.token;
    }

    this._setFormat('json');
    if (this._config.protocol === 'protobuf') {
      this._setFormat('protobuf');
      this._protocol = 'protobuf';
    }

    if (typeof this._endpoint === 'string') {
      const isProtobufURL = startsWith(this._endpoint, 'ws') && this._endpoint.indexOf('format=protobuf') > -1;
      if (isProtobufURL) {
        // Using a URL is a legacy way to define a protocol type. At the moment explicit
        // configuration option is a prefferred way.
        this._setFormat('protobuf');
        this._protocol = 'protobuf';
      } else {
        if (this._config.protocol !== '' && this._config.protocol !== 'json') {
          throw new Error('unsupported protocol ' + this._config.protocol);
        }
        this._setFormat('json');
      }
    } else if (typeof this._endpoint === 'object' && this._endpoint instanceof Array) {
      this._transports = this._endpoint;
      this._emulation = true;
      for (const i in this._transports) {
        const transportConfig = this._transports[i];
        if (!transportConfig.endpoint || !transportConfig.transport) {
          throw new Error('malformed transport configuration');
        }
        const transportName = transportConfig.transport;
        if (['websocket', 'http_stream', 'sse', 'sockjs'].indexOf(transportName) < 0) {
          throw new Error('unsupported transport name: ' + transportName);
        }
      }
    } else {
      throw new Error('unsupported url configuration type: only string or array of objects are supported');
    }
  };

  _setState(newState) {
    if (this._state !== newState) {
      const prevState = this._state;
      this._debug('state', this._state, '->', newState);
      this._state = newState;
      this.emit('state', { 'state': newState, 'prevState': prevState });
      return true;
    }
    return false;
  };

  _isDisconnected() {
    return this._state === states.DISCONNECTED;
  };

  _isConnecting() {
    return this._state === states.CONNECTING;
  };

  _isConnected() {
    return this._state === states.CONNECTED;
  };

  _isClosed() {
    return this._state === states.CLOSED;
  };

  _nextCommandId() {
    return ++this._commandId;
  };

  _getRetryInterval() {
    const interval = backoff(this._reconnectAttempts, this._config.minReconnectDelay, this._config.maxReconnectDelay);
    this._reconnectAttempts += 1;
    return interval;
  };

  _clearConnectedState(reconnect, clearServerSubs, clearClientSubs) {
    this._client = null;
    this._stopPing();

    if (this._refreshTimeout) {
      clearTimeout(this._refreshTimeout);
      this._refreshTimeout = null;
    }

    if (!reconnect && this._reconnectTimeout) {
      clearTimeout(this._reconnectTimeout);
      this._reconnectTimeout = null;
    }

    // fire errbacks of registered outgoing calls.
    for (const id in this._callbacks) {
      if (this._callbacks.hasOwnProperty(id)) {
        const callbacks = this._callbacks[id];
        clearTimeout(callbacks.timeout);
        const errback = callbacks.errback;
        if (!errback) {
          continue;
        }
        errback({ error: this._createErrorObject(0, 'disconnected') });
      }
    }
    this._callbacks = {};

    // fire unsubscribe events.
    for (const channel in this._subs) {
      if (!this._subs.hasOwnProperty(channel)) {
        continue;
      }
      const sub = this._subs[channel];
      const needUnsubscribe = sub._isSubscribed();
      if (sub._isSubscribed()) {
        if (clearClientSubs) {
          sub._setUnsubscribed();
        } else {
          sub._setSubscribing();
        }
      }
      if (needUnsubscribe) {
        sub._triggerUnsubscribe();
      }
    }

    // fire unsubscribe events for server side subs.
    if (this._isConnected()) {
      for (const channel in this._serverSubs) {
        if (this._serverSubs.hasOwnProperty(channel)) {
          this.emit('unsubscribe', { channel: channel });
        }
      }
    }

    if (clearClientSubs) {
      this._subs = {};
    }
    if (clearServerSubs) {
      this._serverSubs = {};
    }
  };

  _handleWriteError(commands) {
    for (let command in commands) {
      let id = command.id;
      if (!(id in this._callbacks)) {
        continue;
      }
      const callbacks = this._callbacks[id];
      clearTimeout(this._callbacks[id].timeout);
      delete this._callbacks[id];
      const errback = callbacks.errback;
      errback({ error: this._createErrorObject(2, 'transport write error') });
    }
  }

  _transportSendCommands(commands) {
    if (!commands.length) {
      return true;
    }
    try {
      this._transport.send(this._encoder.encodeCommands(commands), this._session, this._node);
    } catch (e) {
      this._debug('error writing commands', e);
      this._handleWriteError(commands);
      return false;
    }
    return true;
  }

  _initializeTransport() {
    let websocket;
    if (this._config.websocket !== null) {
      websocket = this._config.websocket;
    } else {
      if (!(typeof WebSocket !== 'function' && typeof WebSocket !== 'object')) {
        websocket = WebSocket;
      }
    }

    let sockjs = null;
    if (this._config.sockjs !== null) {
      sockjs = this._config.sockjs;
    } else {
      if (typeof global.SockJS !== 'undefined') {
        sockjs = global.SockJS;
      }
    }

    let eventsource = null;
    if (this._config.eventsource !== null) {
      eventsource = this._config.eventsource;
    } else {
      if (typeof global.EventSource !== 'undefined') {
        eventsource = global.EventSource;
      }
    }

    let fetchFunc = null;
    if (this._config.fetch !== null) {
      fetchFunc = this._config.fetch;
    } else {
      if (typeof global.fetch !== 'undefined') {
        fetchFunc = global.fetch;
      }
    }

    let readableStream = null;
    if (this._config.readableStream !== null) {
      readableStream = this._config.readableStream;
    } else {
      if (typeof global.ReadableStream !== 'undefined') {
        readableStream = global.ReadableStream;
      }
    }

    if (!this._emulation) {
      if (startsWith(this._endpoint, 'http')) {
        this._debug('client will use sockjs');
        this._transport = new SockjsTransport(this._endpoint, {
          sockjs: sockjs,
          transports: this._config.sockjsTransports,
          server: this._config.sockjsServer,
          timeout: this._config.sockjsTimeout
        });
        if (!this._transport.supported()) {
          throw new Error('SockJS not available, use ws(s):// in url or include SockJS');
        }
      } else {
        this._debug('client will use websocket');
        this._transport = new WebsocketTransport(this._endpoint, {
          websocket: websocket
        });
        if (!this._transport.supported()) {
          throw new Error('WebSocket not available');
        }
      }
    } else {
      if (this._currentTransportIndex >= this._transports.length) {
        this._currentTransportIndex = 0;
      }
      while (true) {
        if (this._currentTransportIndex >= this._transports.length) {
          this._currentTransportIndex = 0;
          throw new Error('no supported transport found');
        }
        const transportConfig = this._transports[this._currentTransportIndex];
        const transportName = transportConfig.transport;
        const transportEndpoint = transportConfig.endpoint;

        if (transportName === 'websocket') {
          this._debug('trying websocket transport');
          this._transport = new WebsocketTransport(transportEndpoint, {
            websocket: websocket
          });
          if (!this._transport.supported()) {
            this._debug('websocket transport not available');
            this._currentTransportIndex++;
            continue;
          }
        } else if (transportName === 'http_stream') {
          this._debug('trying http_stream transport');
          this._transport = new HttpStreamTransport(transportEndpoint, {
            fetch: fetchFunc,
            readableStream: readableStream,
            requestMode: this._config.httpStreamRequestMode,
            emulationEndpoint: this._config.emulationEndpoint,
            emulationRequestMode: this._config.emulationRequestMode,
            decoder: this._decoder,
            encoder: this._encoder
          });
          if (!this._transport.supported()) {
            this._debug('http_stream transport not available');
            this._currentTransportIndex++;
            continue;
          }
        } else if (transportName === 'sse') {
          this._debug('trying sse transport');
          this._transport = new SseTransport(transportEndpoint, {
            eventsource: eventsource,
            fetch: fetchFunc,
            emulationEndpoint: this._config.emulationEndpoint,
            emulationRequestMode: this._config.emulationRequestMode
          });
          if (!this._transport.supported()) {
            this._debug('sse transport not available');
            this._currentTransportIndex++;
            continue;
          }
        } else if (transportName === 'sockjs') {
          this._debug('trying sockjs');
          this._transport = new SockjsTransport(transportEndpoint, {
            sockjs: sockjs,
            transports: this._config.sockjsTransports,
            server: this._config.sockjsServer,
            timeout: this._config.sockjsTimeout
          });
          if (!this._transport.supported()) {
            this._debug('sockjs transport not available');
            this._currentTransportIndex++;
            continue;
          }
        } else {
          throw new Error('unknown transport ' + transportName);
        }
        break;
      }
    }

    const connectCommand = this._constructConnectCommand();

    if (this._transport.emulation()) {
      this._latencyStart = new Date();
      connectCommand.id = this._nextCommandId();
      this._callConnectFake(connectCommand.id).then(resolveCtx => {
        const result = resolveCtx.reply.connect;
        this._connectResponse(result);
        if (resolveCtx.next) {
          resolveCtx.next();
        }
      }, rejectCtx => {
        this._connectError(rejectCtx.error);
        if (rejectCtx.next) {
          rejectCtx.next();
        }
      });
    }

    const self = this;

    let transportName;

    this._transport.initialize(this._protocol, {
      onOpen: function () {
        transportName = self._transport.subName();
        self._debug(transportName, 'transport open');
        self._transportWasOpen = true;
        self._transportClosed = false;

        if (self._transport.emulation()) {
          return;
        }

        self._latencyStart = new Date();

        self._call(connectCommand).then(resolveCtx => {
          const result = resolveCtx.reply.connect;
          self._connectResponse(result);
          if (resolveCtx.next) {
            resolveCtx.next();
          }
        }, rejectCtx => {
          self._connectError(rejectCtx.error);
          if (rejectCtx.next) {
            rejectCtx.next();
          }
        });
      },
      onError: function (e) {
        self._debug('transport level error', e);
      },
      onClose: function (closeEvent) {
        self._debug(transportName, 'transport closed');
        self._transportClosed = true;

        let reason = 'connection closed';
        let needReconnect = true;
        let code = 0;

        if (closeEvent && 'code' in closeEvent && closeEvent.code) {
          code = closeEvent.code;
        }

        if (closeEvent && closeEvent.reason) {
          try {
            const advice = JSON.parse(closeEvent.reason);
            reason = advice.reason;
            needReconnect = advice.reconnect;
          } catch (e) {
            reason = closeEvent.reason;
            if ((code >= 3500 && code < 4000) || (code >= 4500 && code < 5000)) {
              needReconnect = false;
            }
          }
        }

        if (code < 3000) {
          code = 4;
          reason = 'connection closed';
          if (self._emulation && !self._transportWasOpen) {
            self._currentTransportIndex++;
          }
        } else {
          // Codes >= 3000 are sent from a server application level.
          self._transportWasOpen = true;
        }

        let isInitialHandshake = false;
        if (self._emulation && !self._transportWasOpen && self._currentTransportIndex < self._transports.length) {
          isInitialHandshake = true;
        }
        if (isInitialHandshake) {
          code = -1;
        }

        self._disconnect(code, reason, needReconnect);

        if (self._isConnecting()) {
          let interval = self._getRetryInterval();
          if (isInitialHandshake) {
            interval = 0;
          }
          self._debug('reconnect after ' + interval + ' milliseconds');
          self._reconnectTimeout = setTimeout(() => {
            self._startReconnecting();
          }, interval);
        }
      },
      onMessage: function (data) {
        self._dataReceived(data);
      },
      restartPing: function () {
        self._restartPing();
      }
    }, this._encoder.encodeCommands([connectCommand]));
  };

  _startReconnecting() {
    if (!this._isConnecting()) {
      return;
    }
    if (!this._refreshRequired) {
      this._startConnecting();
      return;
    }

    const self = this;

    this._getToken().then(function (token) {
      if (!self._isConnecting()) {
        return;
      }
      if (!token) {
        self._close(closeReasons.UNAUTHORIZED, true, true);
        return;
      }
      self._token = token;
      self._debug('connection token refreshed');
      self._startConnecting();
    }).catch(function (e) {
      if (!self._isConnecting()) {
        return;
      }
      const interval = self._getRetryInterval();
      self._debug('error on connection token refresh, reconnect after ' + interval + ' milliseconds', e);
      self._reconnectTimeout = setTimeout(() => {
        self._startReconnecting();
      }, interval);
    });
  }

  _connectError(err) {
    let isInitialHandshake = false;
    if (err.code < 100 &&
      this._emulation && !this._transportWasOpen &&
      this._currentTransportIndex < this._transports.length) {
      isInitialHandshake = true;
    }
    if (err.code === 112) { // unrecoverable position.
      this._close(closeReasons.UNRECOVERABLE_POSITION, true, false);
      return;
    } else if (err.code === 109) { // token expired.
      this._refreshRequired = true;
    }
    let disconnectCode = 6;
    if (isInitialHandshake) {
      disconnectCode = -1;
    }
    if (err.code < 100 || err.temporary === true || err.code === 109) {
      this._disconnect(disconnectCode, 'connect error', true);
    } else {
      this._closeConnectFailed();
    }
  }

  _constructConnectCommand() {
    const req = {};

    if (this._token) {
      req.token = this._token;
    }
    if (this._config.data) {
      req.data = this._config.data;
    }
    if (this._config.name) {
      req.name = this._config.name;
    }
    if (this._config.version) {
      req.version = this._config.version;
    }

    let subs = {};
    let hasSubs = false;
    for (const channel in this._serverSubs) {
      if (this._serverSubs.hasOwnProperty(channel) && this._serverSubs[channel].recoverable) {
        hasSubs = true;
        let sub = {
          'recover': true
        };
        if (this._serverSubs[channel].offset) {
          sub['offset'] = this._serverSubs[channel].offset;
        }
        if (this._serverSubs[channel].epoch) {
          sub['epoch'] = this._serverSubs[channel].epoch;
        }
        subs[channel] = sub;
      }
    }
    if (hasSubs) {
      req.subs = subs;
    }
    return {
      connect: req
    };
  }

  _getHistoryRequest(channel, options) {
    let params = {
      channel: channel
    };
    if (options !== undefined) {
      if (options.since) {
        params['since'] = {
          'offset': options.since.offset
        };
        if (options.since.epoch) {
          params['since']['epoch'] = options.since.epoch;
        }
      };
      if (options.limit !== undefined) {
        params['limit'] = options.limit;
      }
      if (options.reverse === true) {
        params['reverse'] = true;
      }
    };
    return params;
  }

  _methodCall() {
    if (this._isConnected()) {
      return Promise.resolve();
    }
    return new Promise((res, rej) => {
      const timeout = setTimeout(function () {
        rej({ 'code': 0, 'message': 'timeout' });
      }, this._config.timeout);
      this._promises[this._nextPromiseId()] = {
        timeout: timeout,
        resolve: res,
        reject: rej
      };
    });
  }

  _callPromise(cmd, resultCB) {
    return new Promise((resolve, reject) => {
      this._call(cmd).then(resolveCtx => {
        resolve(resultCB(resolveCtx.reply));
        if (resolveCtx.next) {
          resolveCtx.next();
        }
      }, rejectCtx => {
        reject(rejectCtx.error);
        if (rejectCtx.next) {
          rejectCtx.next();
        }
      });
    });
  }

  _dataReceived(data) {
    if (this._serverPing > 0) {
      this._waitServerPing();
    } else {
      this._restartPing();
    }
    const replies = this._decoder.decodeReplies(data);
    // we have to guarantee order of events in replies processing - i.e. start processing
    // next reply only when we finished processing of current one. Without syncing things in
    // this way we could get wrong publication events order as reply promises resolve
    // on next loop tick so for loop continues before we finished emitting all reply events.
    this._dispatchPromise = this._dispatchPromise.then(() => {
      let finishDispatch;
      this._dispatchPromise = new Promise(resolve => {
        finishDispatch = resolve;
      });
      this._dispatchSynchronized(replies, finishDispatch);
    });
  }

  _dispatchSynchronized(replies, finishDispatch) {
    let p = Promise.resolve();
    for (const i in replies) {
      if (replies.hasOwnProperty(i)) {
        p = p.then(() => {
          return this._dispatchReply(replies[i]);
        });
      }
    }
    p = p.then(() => {
      finishDispatch();
    });
  }

  _dispatchReply(reply) {
    var next;
    const p = new Promise(resolve => {
      next = resolve;
    });

    if (reply === undefined || reply === null) {
      this._debug('dispatch: got undefined or null reply');
      next();
      return p;
    }

    const id = reply.id;

    if (id && id > 0) {
      this._handleReply(reply, next);
    } else {
      if (!reply.push) {
        this._handleServerPing(next);
      } else {
        this._handlePush(reply.push, next);
      }
    }

    return p;
  };

  _call(cmd) {
    return new Promise((resolve, reject) => {
      cmd.id = this._nextCommandId();
      this._registerCall(cmd.id, resolve, reject);
      this._addCommand(cmd);
    });
  }

  _callConnectFake(id) {
    return new Promise((resolve, reject) => {
      this._registerCall(id, resolve, reject);
    });
  }

  _startConnecting() {
    this._debug('start connecting');
    this._setState(states.CONNECTING);
    this._client = null;
    this._initializeTransport();
  }

  _disconnect(code, reason, shouldReconnect, clearServerSubs, clearClientSubs) {
    const reconnect = shouldReconnect || false;

    if (this._isDisconnected() || this._isClosed()) {
      if (!reconnect) {
        this._clearConnectedState(reconnect, clearServerSubs, clearClientSubs);
      }
      return;
    }

    if (code === -1) {
      // Happens during initial handshake when we are trying different transports.
      this._clearConnectedState(reconnect, clearServerSubs, clearClientSubs);
      if (this._transport && !this._transportClosed) {
        this._transportClosed = true;
        this._transport.close();
      }
      return;
    }

    this._clearConnectedState(reconnect, clearServerSubs, clearClientSubs);

    const isNewDisconnect = this._isConnecting &&
      (this._lastDisconnectCode === -1 || (this._lastDisconnectCode !== code && code >= 3000));

    const wasConnected = this._isConnected();

    const needDisconnectEvent = wasConnected || isNewDisconnect;

    const disconnectCtx = {
      code: code,
      reason: reason,
      reconnect: reconnect
    };

    this._debug('disconnect:', reason, shouldReconnect);
    if (shouldReconnect) {
      this._setState(states.CONNECTING);
      if (needDisconnectEvent) {
        this.emit('disconnect', disconnectCtx);
        this._lastDisconnectCode = code;
      }
    } else {
      this._setState(states.DISCONNECTED);
      if (needDisconnectEvent) {
        this.emit('disconnect', disconnectCtx);
        this._close(closeReasons.SERVER, true, true);
      }
    }

    if (this._transport && !this._transportClosed) {
      this._transportClosed = true;
      this._transport.close();
    }
  };

  _closeConnectFailed() {
    this._close(closeReasons.CONNECT_FAILED, false, false);
  }

  _closeRefreshFailed() {
    this._close(closeReasons.REFRESH_FAILED, false, false);
  }

  _closeUnauthorized() {
    this._close(closeReasons.UNAUTHORIZED, false, false);
  }

  _getToken() {
    // ask application for new connection token.
    this._debug('get connection token');
    if (this._config.getConnectionToken === null) {
      throw new Error('provide a function to get connection token');
    }
    return this._config.getConnectionToken({});
  }

  _refresh() {
    const clientId = this._client;
    const self = this;
    this._getToken().then(function (token) {
      if (clientId !== self._client) {
        return;
      }
      if (!token) {
        self._closeUnauthorized();
        return;
      }
      self._token = token;
      self._debug('connection token refreshed');

      if (!self._isConnected()) {
        return;
      }

      const cmd = {
        refresh: { token: self._token }
      };

      self._call(cmd).then(resolveCtx => {
        const result = resolveCtx.reply.refresh;
        self._refreshResponse(result);
        if (resolveCtx.next) {
          resolveCtx.next();
        }
      }, rejectCtx => {
        self._refreshError(rejectCtx.error);
        if (rejectCtx.next) {
          rejectCtx.next();
        }
      });
    }).catch(function (e) {
      self._debug('error refreshing connection token', e);
      self._refreshTimeout = setTimeout(() => self._refresh(), backoff(0, 5000, 10000));
    });
  };

  _refreshError(err) {
    this._debug('refresh error', err);
    if (err.code < 100 || err.temporary === true) {
      this._refreshTimeout = setTimeout(() => this._refresh(), backoff(0, 5000, 10000));
    } else {
      this._closeRefreshFailed();
    }
  }

  _refreshResponse(result) {
    if (this._refreshTimeout) {
      clearTimeout(this._refreshTimeout);
      this._refreshTimeout = null;
    }
    if (result.expires) {
      this._client = result.client;
      this._refreshTimeout = setTimeout(() => this._refresh(), ttlMilliseconds(result.ttl));
    }
  };

  _subscribe(sub) {
    this._debug('subscribing on', sub.channel);
    const channel = sub.channel;

    if (!(channel in this._subs)) {
      this._subs[channel] = sub;
    }

    if (!this._isConnected()) {
      // subscribe will be called later.
      return;
    }

    // If channel name does not start with privateChannelPrefix - then we
    // can just send subscribe command to the server. If channel name
    // starts with privateChannelPrefix - then this is a private channel
    // and we should get subscription token first.
    if (startsWith(channel, this._config.privateChannelPrefix)) {
      // private channel, need to get token before sending subscribe.
      const clientId = this._client;
      const self = this;
      if (sub._token) {
        this._sendSubscribe(sub, sub._token);
      } else {
        sub._getToken().then(function (token) {
          if (clientId !== self._client) {
            return;
          }
          if (!sub._isSubscribing()) {
            return;
          }
          if (!token) {
            sub._closeUnauthorized();
            return;
          }
          if (!sub._tokenUniquePerConnection) {
            // Persist token in subscription.
            sub._token = token;
          }
          self._sendSubscribe(sub, token);
        }).catch(function () {
          // TODO: make sure subscription properly retried later.
          sub._subscribeError({ code: 0, message: 'token error' });
        });
      }
    } else {
      this._sendSubscribe(sub);
    }
  };

  _sendSubscribe(sub, token) {
    const channel = sub.channel;

    const req = {
      channel: channel
    };

    if (token) {
      req.token = token;
    }

    if (sub._data) {
      req.data = sub._data;
    }

    if (sub._needRecover()) {
      req.recover = true;
      const offset = sub._getLastOffset();
      if (offset) {
        req.offset = offset;
      }
      const epoch = sub._getLastEpoch();
      if (epoch) {
        req.epoch = epoch;
      }
    }

    const cmd = {
      subscribe: req
    };

    this._call(cmd).then(resolveCtx => {
      const result = resolveCtx.reply.subscribe;
      this._subscribeResponse(
        channel,
        result
      );
      if (resolveCtx.next) {
        resolveCtx.next();
      }
    }, rejectCtx => {
      this._subscribeError(channel, rejectCtx.error);
      if (rejectCtx.next) {
        rejectCtx.next();
      }
    });
  }

  _sendSubRefresh(sub, token) {
    const req = {
      channel: sub.channel,
      token: token
    };
    const cmd = {
      'sub_refresh': req
    };

    this._call(cmd).then(resolveCtx => {
      const result = resolveCtx.reply.sub_refresh;
      sub._refreshResponse(result);
      if (resolveCtx.next) {
        resolveCtx.next();
      }
    }, rejectCtx => {
      sub._refreshError(rejectCtx.error);
      if (rejectCtx.next) {
        rejectCtx.next();
      }
    });
  }

  _removeSubscription(sub) {
    delete this._subs[sub.channel];
  }

  _unsubscribe(sub) {
    if (!this._isConnected()) {
      // No need to send unsubscribe command in disconnected state.
      return;
    }
    const req = {
      channel: sub.channel
    };
    const cmd = {
      unsubscribe: req
    };
    cmd.id = this._nextCommandId();
    this._addCommand(cmd);
  };

  _getSub(channel) {
    const sub = this._subs[channel];
    if (!sub) {
      return null;
    }
    return sub;
  };

  _isServerSub(channel) {
    return this._serverSubs[channel] !== undefined;
  };

  _connectResponse(result) {
    this._transportWasOpen = true;
    this._reconnectAttempts = 0;
    this._refreshRequired = false;

    if (this._isConnected()) {
      return;
    }

    if (this._latencyStart !== null) {
      this._latency = (new Date()).getTime() - this._latencyStart.getTime();
      this._latencyStart = null;
    }

    this._client = result.client;
    this._setState(states.CONNECTED);

    if (this._refreshTimeout) {
      clearTimeout(this._refreshTimeout);
    }
    if (result.expires) {
      this._refreshTimeout = setTimeout(() => this._refresh(), ttlMilliseconds(result.ttl));
    }

    this._session = result.session;
    this._node = result.node;

    this.startBatching();
    for (const channel in this._subs) {
      if (this._subs.hasOwnProperty(channel)) {
        const sub = this._subs[channel];
        if (sub._isSubscribing()) {
          this._subscribe(sub);
        }
      }
    }
    this.stopBatching();

    const ctx = {
      client: result.client,
      transport: this._transport.subName()
    };
    if (result.data) {
      ctx.data = result.data;
    }

    this.emit('connect', ctx);

    this._resolvePromises();

    if (result.subs) {
      this._processServerSubs(result.subs);
    }

    if (result.ping && result.ping > 0) {
      this._serverPing = result.ping * 1000;
      this._sendPong = result.pong === true;
      this._waitServerPing();
    } else {
      this._serverPing = 0;
      this._startClientPing();
    }
  };

  _processServerSubs(subs) {
    for (const channel in subs) {
      if (subs.hasOwnProperty(channel)) {
        const sub = subs[channel];
        const subCtx = this._getSubscribeContext(channel, sub);
        this.emit('subscribe', subCtx);
      }
    }
    for (const channel in subs) {
      if (subs.hasOwnProperty(channel)) {
        const sub = subs[channel];
        if (sub.recovered) {
          let pubs = sub.publications;
          if (pubs && pubs.length > 0) {
            for (let i in pubs) {
              if (pubs.hasOwnProperty(i)) {
                this._handlePublication(channel, pubs[i]);
              }
            }
          }
        }
        this._serverSubs[channel] = {
          'offset': sub.offset,
          'epoch': sub.epoch,
          'recoverable': sub.recoverable
        };
      }
    }
  };

  _stopPing() {
    if (this._serverPingTimeout !== null) {
      clearTimeout(this._serverPingTimeout);
      this._serverPingTimeout = null;
    }
    if (this._pongTimeout !== null) {
      clearTimeout(this._pongTimeout);
      this._pongTimeout = null;
    }
    if (this._pingTimeout !== null) {
      clearTimeout(this._pingTimeout);
      this._pingTimeout = null;
    }
  };

  _waitServerPing() {
    if (this._config.maxServerPingDelay === 0) {
      return;
    }
    if (!this._isConnected()) {
      return;
    }
    if (this._serverPingTimeout) {
      clearTimeout(this._serverPingTimeout);
    }
    this._serverPingTimeout = setTimeout(() => {
      if (!this._isConnected()) {
        this._stopPing();
        return;
      }
      this._disconnect(11, 'no ping', true);
    }, this._serverPing + this._config.maxServerPingDelay);
  };

  _startClientPing() {
    if (this._config.pingInterval <= 0) {
      return;
    }
    if (!this._isConnected()) {
      return;
    }
    this._pingTimeout = setTimeout(() => {
      if (!this._isConnected()) {
        this._stopPing();
        return;
      }
      this._ping();
      this._pongTimeout = setTimeout(() => {
        this._disconnect(11, 'no ping', true);
      }, this._config.pongWaitTimeout);
    }, this._config.pingInterval);
  };

  _restartPing() {
    this._stopPing();
    this._startClientPing();
  };

  _subscribeError(channel, error) {
    const sub = this._getSub(channel);
    if (!sub) {
      return;
    }
    if (!sub._isSubscribing()) {
      return;
    }
    if (error.code === 1) { // client side timeout.
      this._disconnect(10, 'subscribe timeout', true);
      return;
    }
    sub._subscribeError(error);
  };

  _getSubscribeContext(channel, result) {
    const ctx = {
      channel: channel
    };
    let positioned = false;
    if ('positioned' in result) {
      positioned = result.positioned;
    }
    let epoch = '';
    if ('epoch' in result) {
      epoch = result.epoch;
    }
    let offset = 0;
    if ('offset' in result) {
      offset = result.offset;
    }
    if (positioned) {
      ctx.streamPosition = {
        'offset': offset,
        'epoch': epoch
      };
    };
    if (result.data) {
      ctx.data = result.data;
    }
    return ctx;
  }

  _subscribeResponse(channel, result) {
    const sub = this._getSub(channel);
    if (!sub) {
      return;
    }
    if (!sub._isSubscribing()) {
      return;
    }
    sub._setSubscribed(result);
  };

  _handleReply(reply, next) {
    const id = reply.id;
    if (!(id in this._callbacks)) {
      next();
      return;
    }
    const callbacks = this._callbacks[id];
    clearTimeout(this._callbacks[id].timeout);
    delete this._callbacks[id];

    if (!errorExists(reply)) {
      const callback = callbacks.callback;
      if (!callback) {
        return;
      }
      callback({ reply, next });
    } else {
      const errback = callbacks.errback;
      if (!errback) {
        next();
        return;
      }
      const error = reply.error;
      errback({ error, next });
    }
  }

  _handleJoin(channel, join) {
    const sub = this._getSub(channel);
    if (!sub) {
      if (this._isServerSub(channel)) {
        const ctx = { channel: channel, info: this._getJoinLeaveContext(join.info) };
        this.emit('join', ctx);
      }
      return;
    }
    sub._handleJoin(join);
  };

  _handleLeave(channel, leave) {
    const sub = this._getSub(channel);
    if (!sub) {
      if (this._isServerSub(channel)) {
        const ctx = { 'channel': channel, 'info': this._getJoinLeaveContext(leave.info) };
        this.emit('leave', ctx);
      }
      return;
    }
    sub._handleLeave(leave);
  };

  _handleUnsubscribe(channel, unsub) {
    const ctx = {};
    const sub = this._getSub(channel);
    if (!sub) {
      if (this._isServerSub(channel)) {
        delete this._serverSubs[channel];
        ctx.channel = channel;
        this.emit('unsubscribe', ctx);
      }
      return;
    }

    if (unsub.type === 1) { // Insufficient.
      sub._setUnsubscribed(false);
      sub.subscribe();
    } else if (unsub.type === 2) { // Unrecoverable.
      sub._close(sub.CLOSE_UNRECOVERABLE_POSITION, true);
    } else {
      sub._close(sub.CLOSE_SERVER, false);
    };
  };

  _handleSubscribe(channel, sub) {
    this._serverSubs[channel] = {
      'offset': sub.offset,
      'epoch': sub.epoch,
      'recoverable': sub.recoverable
    };
    this.emit('subscribe', this._getSubscribeContext(channel, sub));
  };

  _handleDisconnect(disconnect) {
    const code = disconnect.code;
    let needReconnect = true;
    if ((code >= 3500 && code < 4000) || (code >= 4500 && code < 5000)) {
      needReconnect = false;
    }
    this._disconnect(code, disconnect.reason, needReconnect);
  };

  _getPublicationContext(channel, pub) {
    const ctx = {
      'channel': channel,
      'data': pub.data
    };
    if (pub.offset) {
      ctx.offset = pub.offset;
    }
    if (pub.info) {
      ctx.info = this._getJoinLeaveContext(pub.info);
    }
    if (pub.tags) {
      ctx.tags = pub.tags;
    }
    return ctx;
  }

  _getJoinLeaveContext(clientInfo) {
    const info = {
      client: clientInfo.client,
      user: clientInfo.user
    };
    if (clientInfo.conn_info) {
      info.connInfo = clientInfo.conn_info;
    }
    if (clientInfo.chan_info) {
      info.chanInfo = clientInfo.chan_info;
    }
    return info;
  }

  _handlePublication(channel, pub) {
    const sub = this._getSub(channel);
    if (!sub) {
      if (this._isServerSub(channel)) {
        const ctx = this._getPublicationContext(channel, pub);
        this.emit('publication', ctx);
        if (pub.offset !== undefined) {
          this._serverSubs[channel].offset = pub.offset;
        }
      }
      return;
    }
    sub._handlePublication(pub);
  };

  _handleMessage(message) {
    this.emit('message', message.data);
  };

  _handleServerPing(next) {
    if (this._sendPong) {
      const cmd = {};
      this._transportSendCommands([cmd]);
    }
    next();
  }

  _handlePush(data, next) {
    const channel = data.channel;
    if (data.pub) {
      this._handlePublication(channel, data.pub);
    } else if (data.message) {
      this._handleMessage(data.message);
    } else if (data.join) {
      this._handleJoin(channel, data.join);
    } else if (data.leave) {
      this._handleLeave(channel, data.leave);
    } else if (data.unsubscribe) {
      this._handleUnsubscribe(channel, data.unsubscribe);
    } else if (data.subscribe) {
      this._handleSubscribe(channel, data.subscribe);
    } else if (data.disconnect) {
      this._handleDisconnect(data.disconnect);
    }
    next();
  }

  _flush() {
    const commands = this._commands.slice(0);
    this._commands = [];
    this._transportSendCommands(commands);
  };

  _ping() {
    const cmd = {};
    this._call(cmd).then(resolveCtx => {
      if (resolveCtx.next) {
        resolveCtx.next();
      }
    }, rejectCtx => {
      this._debug('ping error', rejectCtx.error);
      if (rejectCtx.next) {
        rejectCtx.next();
      }
    });
  };

  _pingResponse() {
    if (!this._isConnected()) {
      return;
    }
    this._stopPing();
    this._startClientPing();
  }

  _createErrorObject(code, message, temporary) {
    const errObject = {
      code: code,
      message: message
    };
    if (temporary) {
      errObject.temporary = true;
    }
    return errObject;
  };

  _registerCall(id, callback, errback) {
    this._callbacks[id] = {
      callback: callback,
      errback: errback,
      timeout: null
    };
    this._callbacks[id].timeout = setTimeout(() => {
      delete this._callbacks[id];
      if (isFunction(errback)) {
        errback({ error: this._createErrorObject(1, 'timeout') });
      }
    }, this._config.timeout);
  };

  _addCommand(command) {
    if (this._isBatching) {
      this._commands.push(command);
    } else {
      this._transportSendCommands([command]);
    }
  };

  _close(reason, clearServerSubs, clearClientSubs) {
    this._disconnect(0, 'closing', false, clearServerSubs, clearClientSubs);
    this._setState(states.CLOSED);
    this.emit('close', { reason: reason });
    this._rejectPromises({ state: states.CLOSED });
  }

  _nextPromiseId() {
    return ++this._promiseId;
  }

  _resolvePromises() {
    for (const id in this._promises) {
      if (this._promises[id].timeout) {
        clearTimeout(this._promises[id].timeout);
      }
      this._promises[id].resolve();
      delete this._promises[id];
    }
  }

  _rejectPromises(err) {
    for (const id in this._promises) {
      if (this._promises[id].timeout) {
        clearTimeout(this._promises[id].timeout);
      }
      this._promises[id].reject(err);
      delete this._promises[id];
    }
  }
}

Centrifuge.STATE_DISCONNECTED =
  Centrifuge.prototype.STATE_DISCONNECTED = states.DISCONNECTED;
Centrifuge.STATE_CONNECTING =
  Centrifuge.prototype.STATE_CONNECTING = states.CONNECTING;
Centrifuge.STATE_CONNECTED =
  Centrifuge.prototype.STATE_CONNECTED = states.CONNECTED;
Centrifuge.STATE_CLOSED =
  Centrifuge.prototype.STATE_CLOSED = states.CLOSED;

Centrifuge.CLOSE_CLIENT =
  Centrifuge.prototype.CLOSE_CLIENT = closeReasons.CLIENT;
Centrifuge.CLOSE_SERVER =
  Centrifuge.prototype.CLOSE_SERVER = closeReasons.SERVER;
Centrifuge.CLOSE_CONNECT_FAILED =
  Centrifuge.prototype.CLOSE_CONNECT_FAILED = closeReasons.CONNECT_FAILED;
Centrifuge.CLOSE_REFRESH_FAILED =
  Centrifuge.prototype.CLOSE_REFRESH_FAILED = closeReasons.REFRESH_FAILED;
Centrifuge.CLOSE_UNAUTHORIZED =
  Centrifuge.prototype.CLOSE_UNAUTHORIZED = closeReasons.UNAUTHORIZED;
Centrifuge.CLOSE_UNRECOVERABLE_POSITION =
  Centrifuge.prototype.CLOSE_UNRECOVERABLE_POSITION = closeReasons.UNRECOVERABLE_POSITION;
