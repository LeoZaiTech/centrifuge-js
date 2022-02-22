import EventEmitter from 'events';
import Subscription from './subscription';

import { SockjsTransport } from './transport_sockjs';
import { WebsocketTransport } from './transport_websocket';
import { HttpStreamTransport } from './transport_http_stream';
import { SseTransport } from './transport_sse';

import {
  JsonEncoder,
  JsonDecoder,
  JsonMethodType,
  JsonPushType
} from './json';

import {
  isFunction,
  log,
  startsWith,
  errorExists,
  backoff,
  extend
} from './utils';

const _errorTimeout = 'timeout';
const _errorConnectionClosed = 'connection closed';

const states = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  CLOSED: 'closed'
};

export class Centrifuge extends EventEmitter {

  constructor(endpoint, options) {
    super();
    this._endpoint = endpoint;
    this._transports = [];
    this._emulation = false;
    this._currentTransportIndex = 0;
    this._transportWasOpen = false;
    this._transport = null;
    this._transportClosed = true;
    this._methodType = null;
    this._pushType = null;
    this._encoder = null;
    this._decoder = null;
    this._state = states.DISCONNECTED;
    this._reconnect = true;
    this._reconnecting = false;
    this._messageId = 0;
    this._clientID = null;
    this._session = '';
    this._node = '';
    this._refreshRequired = false;
    this._subs = {};
    this._serverSubs = {};
    this._lastSeq = {};
    this._lastGen = {};
    this._lastOffset = {};
    this._lastEpoch = {};
    this._messages = [];
    this._isBatching = false;
    this._isSubscribeBatching = false;
    this._privateChannels = {};
    this._numRefreshFailed = 0;
    this._refreshTimeout = null;
    this._pingTimeout = null;
    this._pongTimeout = null;
    this._subRefreshTimeouts = {};
    this._retries = 0;
    this._callbacks = {};
    this._latency = null;
    this._latencyStart = null;
    this._connectData = null;
    this._token = null;
    this._xhrID = 0;
    this._xhrs = {};
    this._dispatchPromise = Promise.resolve();
    this._protocol = 'json';
    this._serverPing = 0;
    this._sendPong = false;
    this._serverPingTimeout = null;
    this._config = {
      protocol: 'json',
      protocolVersion: 'v1',
      debug: false,
      name: 'js',
      version: '',
      fetch: null,
      readableStream: null,
      websocket: null,
      sockjs: null,
      eventsource: null,
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
      xmlhttprequest: null,
      minRetry: 1000,
      maxRetry: 20000,
      timeout: 5000,
      ping: true,
      pingInterval: 25000,
      pongWaitTimeout: 5000,
      maxServerPingDelay: 10000,
      privateChannelPrefix: '$',
      onTransportClose: null,
      refreshEndpoint: '/centrifuge/refresh',
      refreshHeaders: {},
      refreshParams: {},
      refreshData: {},
      refreshAttempts: null,
      refreshInterval: 1000,
      onRefreshFailed: null,
      onRefresh: null,
      subscribeEndpoint: '/centrifuge/subscribe',
      subscribeHeaders: {},
      subscribeParams: {},
      subRefreshInterval: 1000,
      onPrivateSubscribe: null,
      disableWithCredentials: false,
      httpStreamRequestMode: 'cors',
      emulationEndpoint: '/emulation',
      emulationRequestMode: 'cors'
    };
    this._configure(options);
  }

  setToken(token) {
    this._token = token;
  }

  setConnectData(data) {
    this._connectData = data;
  }

  setRefreshHeaders(headers) {
    this._config.refreshHeaders = headers;
  }

  setRefreshParams(params) {
    this._config.refreshParams = params;
  }

  setRefreshData(data) {
    this._config.refreshData = data;
  }

  setSubscribeHeaders(headers) {
    this._config.subscribeHeaders = headers;
  }

  setSubscribeParams(params) {
    this._config.subscribeParams = params;
  }

  _ajax(url, params, headers, data, callback) {
    let query = '';
    this._debug('sending AJAX request to', url, 'with data', JSON.stringify(data));

    let xhr;
    if (this._config.xmlhttprequest !== null) {
      // use explicitly passed XMLHttpRequest object.
      xhr = new this._config.xmlhttprequest();
    } else {
      xhr = (global.XMLHttpRequest ? new global.XMLHttpRequest() : new global.ActiveXObject('Microsoft.XMLHTTP'));
    }

    for (const i in params) {
      if (params.hasOwnProperty(i)) {
        if (query.length > 0) {
          query += '&';
        }
        query += encodeURIComponent(i) + '=' + encodeURIComponent(params[i]);
      }
    }
    if (query.length > 0) {
      query = '?' + query;
    }
    xhr.open('POST', url + query, true);
    if ('withCredentials' in xhr) {
      xhr.withCredentials = !this._config.disableWithCredentials;
    }

    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    xhr.setRequestHeader('Content-Type', 'application/json');
    for (const headerName in headers) {
      if (headers.hasOwnProperty(headerName)) {
        xhr.setRequestHeader(headerName, headers[headerName]);
      }
    }

    xhr.onreadystatechange = () => {
      if (xhr.readyState === 4) {
        if (xhr.status === 200) {
          let data, parsed = false;
          try {
            data = JSON.parse(xhr.responseText);
            parsed = true;
          } catch (e) {
            callback({
              error: 'Invalid JSON. Data was: ' + xhr.responseText,
              status: 200,
              data: null
            });
          }
          if (parsed) { // prevents double execution.
            callback({
              data: data,
              status: 200
            });
          }
        } else {
          this._log('wrong status code in AJAX response', xhr.status);
          callback({
            status: xhr.status,
            data: null
          });
        }
      }
    };
    setTimeout(() => xhr.send(JSON.stringify(data)), 20);
    return xhr;
  };

  _log() {
    log('info', arguments);
  };

  _debug() {
    if (this._config.debug === true) {
      log('debug', arguments);
    }
  };

  _setFormat(format) {
    if (this._formatOverride(format)) {
      return;
    }
    if (format === 'protobuf') {
      throw new Error('not implemented by JSON only Centrifuge client – use client with Protobuf');
    }
    this._methodType = JsonMethodType;
    this._pushType = JsonPushType;
    this._encoder = new JsonEncoder();
    this._decoder = new JsonDecoder();
  }

  _formatOverride(format) {
    return false;
  }

  _configure(configuration) {
    if (!('Promise' in global)) {
      throw new Error('Promise polyfill required');
    }

    extend(this._config, configuration || {});
    this._debug('centrifuge config', this._config);

    if (!this._endpoint) {
      throw new Error('endpoint configuration required');
    }

    if (this._config.protocol !== 'json' && this._config.protocol !== 'protobuf') {
      throw new Error('unsupported protocol ' + this._config.protocol);
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
        if (transportName !== 'websocket' && transportName !== 'http_stream' && transportName !== 'sse') {
          throw new Error('unsupported transport name: ' + transportName);
        }
      }
    } else {
      throw new Error('unsupported url configuration type: only string or array of objects are supported');
    }

    if (this._config.protocolVersion !== 'v1' && this._config.protocolVersion !== 'v2') {
      throw new Error('unsupported protocol version ' + this._config.protocolVersion);
    }
  };

  _setState(newState) {
    if (this._state !== newState) {
      this._debug('State', this._state, '->', newState);
      this._state = newState;
    }
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

  _nextMessageId() {
    return ++this._messageId;
  };

  _resetRetry() {
    this._debug('reset retries count to 0');
    this._retries = 0;
  };

  _getRetryInterval() {
    const interval = backoff(this._retries, this._config.minRetry, this._config.maxRetry);

    this._retries += 1;
    return interval;
  };

  _abortInflightXHRs() {
    for (const xhrID in this._xhrs) {
      try {
        this._xhrs[xhrID].abort();
      } catch (e) {
        this._debug('error aborting xhr', e);
      }
      delete this._xhrs[xhrID];
    }
  };

  _clearConnectedState(reconnect) {
    this._clientID = null;
    this._stopPing();

    if (this._refreshTimeout) {
      clearTimeout(this._refreshTimeout);
      this._refreshTimeout = null;
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
        errback({ error: this._createErrorObject('disconnected') });
      }
    }
    this._callbacks = {};

    // fire unsubscribe events
    for (const channel in this._subs) {
      if (this._subs.hasOwnProperty(channel)) {
        const sub = this._subs[channel];

        if (reconnect) {
          if (sub._isSuccess()) {
            sub._triggerUnsubscribe();
            sub._recover = true;
          }
          if (sub._shouldResubscribe()) {
            sub._setSubscribing();
          }
        } else {
          sub._setUnsubscribed();
        }
      }
    }

    this._abortInflightXHRs();

    // clear refresh timer
    if (this._refreshTimeout !== null) {
      clearTimeout(this._refreshTimeout);
      this._refreshTimeout = null;
    }

    // clear sub refresh timers
    for (const channel in this._subRefreshTimeouts) {
      if (this._subRefreshTimeouts.hasOwnProperty(channel) && this._subRefreshTimeouts[channel]) {
        this._clearSubRefreshTimeout(channel);
      }
    }
    this._subRefreshTimeouts = {};

    if (!this._reconnect) {
      // completely clear subscriptions
      this._subs = {};
    }
  };

  _transportSend(commands) {
    if (!commands.length) {
      return true;
    }

    if (!this._transport || !this._transport.isOpen()) {
      // resolve pending commands with error if transport is not open
      for (let command in commands) {
        let id = command.id;
        if (!(id in this._callbacks)) {
          continue;
        }
        const callbacks = this._callbacks[id];
        clearTimeout(this._callbacks[id].timeout);
        delete this._callbacks[id];
        const errback = callbacks.errback;
        errback({ error: this._createErrorObject(_errorConnectionClosed, 0) });
      }
      return false;
    }
    this._transport.send(this._encoder.encodeCommands(commands), this._session, this._node);
    return true;
  }

  _getSubProtocol() {
    if (this._protocol === 'json') {
      return '';
    }
    return 'centrifuge-' + this._protocol;
  }

  _setupTransport() {
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
        this._debug('client will use SockJS');
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
        this._debug('client will use WebSocket');
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
          this._transport = new WebsocketTransport(transportEndpoint, {
            websocket: websocket
          });
          if (!this._transport.supported()) {
            this._debug('WebSocket not available');
            this._currentTransportIndex++;
            continue;
          }
        } else if (transportName === 'http_stream') {
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
            this._debug('HTTP stream not available');
            this._currentTransportIndex++;
            continue;
          }
        } else if (transportName === 'sse') {
          this._transport = new SseTransport(transportEndpoint, {
            eventsource: eventsource,
            fetch: fetchFunc,
            emulationEndpoint: this._config.emulationEndpoint,
            emulationRequestMode: this._config.emulationRequestMode
          });
          if (!this._transport.supported()) {
            this._debug('SSE not available');
            this._currentTransportIndex++;
            continue;
          }
        }
        break;
      }
    }

    const connectCommand = this._constructConnectCommand();

    if (this._transport.emulation()) {
      this._latencyStart = new Date();
      connectCommand.id = this._nextMessageId();
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

    this._transport.initialize(this._protocol, {
      onOpen: function () {
        self._transportWasOpen = true;
        self._transportClosed = false;

        if (self._transport.emulation()) {
          return;
        }

        self._latencyStart = new Date();

        console.log(connectCommand);
        self._call(connectCommand).then(resolveCtx => {
          console.log(resolveCtx);
          let result;
          if (self._config.protocolVersion === 'v1') {
            result = self._decoder.decodeCommandResult(self._methodType.CONNECT, resolveCtx.reply.result);
          } else {
            result = resolveCtx.reply.connect;
          }
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
        self._transportClosed = true;

        let reason = _errorConnectionClosed;
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
          // Codes >= 3000 come from a server application level.
          self._transportWasOpen = true;
        }

        // onTransportClose callback should be executed every time transport was closed.
        // This can be helpful to catch failed connection events (because our disconnect
        // event only called once and every future attempts to connect do not fire disconnect
        // event again).
        if (self._config.onTransportClose !== null) {
          const ctx = {
            event: closeEvent,
            reason: reason,
            reconnect: needReconnect
          };
          if (this._config.protocolVersion === 'v2') {
            ctx['code'] = code;
          }
          self._config.onTransportClose(ctx);
        }

        let isInitialHandshake = false;
        if (self._emulation && !self._transportWasOpen && self._currentTransportIndex < self._transports.length) {
          isInitialHandshake = true;
        }

        self._disconnect(code, reason, needReconnect, isInitialHandshake);

        if (self._reconnect === true) {
          self._reconnecting = true;
          let interval = self._getRetryInterval();

          if (isInitialHandshake) {
            interval = 0;
          }

          self._debug('reconnect after ' + interval + ' milliseconds');
          setTimeout(() => {
            if (self._reconnect === true) {
              if (self._refreshRequired) {
                self._refresh();
              } else {
                self._connect();
              }
            }
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

  _connectError(err) {
    if (err.code === 112) { // unrecoverable position.
      this._handleClose();
      return;
    }
    if (err.code === 109) { // token expired.
      this._refreshRequired = true;
    }
    this._disconnect(6, 'connect error', true);
  }

  _constructConnectCommand() {
    const req = {};

    if (this._token) {
      req.token = this._token;
    }
    if (this._connectData) {
      req.data = this._connectData;
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
        if (this._serverSubs[channel].seq || this._serverSubs[channel].gen) {
          if (this._serverSubs[channel].seq) {
            sub['seq'] = this._serverSubs[channel].seq;
          }
          if (this._serverSubs[channel].gen) {
            sub['gen'] = this._serverSubs[channel].gen;
          }
        } else {
          if (this._serverSubs[channel].offset) {
            sub['offset'] = this._serverSubs[channel].offset;
          }
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

    const cmd = {};
    if (this._config.protocolVersion === 'v2') {
      cmd.connect = req;
    } else {
      // Can omit CONNECT method here due to zero value.
      cmd.params = req;
    }
    return cmd;
  }

  rpc(data) {
    return this._rpc('', data);
  }

  namedRPC(method, data) {
    return this._rpc(method, data);
  }

  _rpc(method, data) {
    const req = {
      data: data
    };
    if (method !== '') {
      req.method = method;
    };
    const msg = {};
    if (this._config.protocolVersion === 'v2') {
      msg.rpc = req;
    } else {
      msg.method = this._methodType.RPC;
      msg.params = req;
    }
    let self = this;
    return this._methodCall(msg, function (reply) {
      let result;
      if (self._config.protocolVersion === 'v1') {
        result = self._decoder.decodeCommandResult(self._methodType.RPC, reply.result);
      } else {
        result = reply.rpc;
      }
      return {
        'data': result.data
      };
    });
  }

  send(data) {
    const req = {
      data: data
    };
    const msg = {};
    if (this._config.protocolVersion === 'v2') {
      msg.send = req;
    } else {
      msg.method = this._methodType.SEND;
      msg.params = req;
    }

    if (!this.isConnected()) {
      return Promise.reject(this._createErrorObject(_errorConnectionClosed, 0));
    }

    const sent = this._transportSend([msg]); // can send async message to server without id set
    if (!sent) {
      return Promise.reject(this._createErrorObject(_errorConnectionClosed, 0));
    };
    return Promise.resolve({});
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

  _methodCall(msg, resultCB) {
    if (!this.isConnected()) {
      return Promise.reject(this._createErrorObject(_errorConnectionClosed, 0));
    }
    return new Promise((resolve, reject) => {
      this._call(msg).then(resolveCtx => {
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

  publish(channel, data) {
    const req = {
      channel: channel,
      data: data
    };
    const msg = {};
    if (this._config.protocolVersion === 'v2') {
      msg.publish = req;
    } else {
      msg.method = this._methodType.PUBLISH;
      msg.params = req;
    }
    return this._methodCall(msg, function () {
      return {};
    });
  }

  history(channel, options) {
    const req = this._getHistoryRequest(channel, options);
    const msg = {};
    if (this._config.protocolVersion === 'v2') {
      msg.history = req;
    } else {
      msg.method = this._methodType.HISTORY;
      msg.params = req;
    }
    let self = this;
    return this._methodCall(msg, function (reply) {
      let result;
      if (self._config.protocolVersion === 'v1') {
        result = self._decoder.decodeCommandResult(self._methodType.HISTORY, reply.result);
      } else {
        result = reply.history;
      }
      return {
        'publications': result.publications,
        'epoch': result.epoch || '',
        'offset': result.offset || 0
      };
    });
  }

  presence(channel) {
    const req = {
      channel: channel
    };
    const msg = {};
    if (this._config.protocolVersion === 'v2') {
      msg.presence = req;
    } else {
      msg.method = this._methodType.PRESENCE;
      msg.params = req;
    }
    let self = this;
    return this._methodCall(msg, function (reply) {
      let result;
      if (self._config.protocolVersion === 'v1') {
        result = self._decoder.decodeCommandResult(self._methodType.PRESENCE, reply.result);
      } else {
        result = reply.presence;
      }
      return {
        'presence': result.presence
      };
    });
  }

  presenceStats(channel) {
    const req = {
      channel: channel
    };
    const msg = {};
    if (this._config.protocolVersion === 'v2') {
      msg['presence_stats'] = req;
    } else {
      msg.method = this._methodType.PRESENCE_STATS;
      msg.params = req;
    }
    return this._methodCall(msg, function (reply) {
      let result;
      if (self._config.protocolVersion === 'v1') {
        result = self._decoder.decodeCommandResult(self._methodType.PRESENCE_STATS, reply.result);
      } else {
        result = reply.presence_stats;
      }
      return {
        'num_users': result.num_users,
        'num_clients': result.num_clients
      };
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
      if (this._config.protocolVersion === 'v1') {
        this._handlePush(reply.result, next);
      } else {
        if (!reply.push) {
          this._handleServerPing(next);
        } else {
          this._handlePushV2(reply.push, next);
        }
      }
    }

    return p;
  };

  _call(msg) {
    return new Promise((resolve, reject) => {
      const id = this._addMessage(msg);
      this._registerCall(id, resolve, reject);
    });
  }

  _callConnectFake(id) {
    return new Promise((resolve, reject) => {
      this._registerCall(id, resolve, reject);
    });
  }

  _connect() {
    if (this.isConnected()) {
      this._debug('connect called when already connected');
      return;
    }
    if (this._isConnecting()) {
      return;
    }

    this._debug('start connecting');
    this._setState(states.CONNECTING);
    this._clientID = null;
    this._reconnect = true;
    this._setupTransport();
  };

  _handleClose() {
    this._serverSubs = {};
    this._clearConnectedState(true);
    this._setState(states.CLOSED);
    if (this._transport && !this._transportClosed) {
      this._transport.close();
    }
    this.emit('close');
  };

  _disconnect(code, reason, shouldReconnect, isInitialHandshake) {
    const reconnect = shouldReconnect || false;
    if (reconnect === false) {
      this._reconnect = false;
    }

    if (this._isDisconnected()) {
      if (!reconnect) {
        this._clearConnectedState(reconnect);
      }
      return;
    }

    this._clearConnectedState(reconnect);

    this._debug('disconnected:', reason, shouldReconnect);
    this._setState(states.DISCONNECTED);

    if (this._reconnecting === false) {
      // fire unsubscribe events for server side subs.
      for (const channel in this._serverSubs) {
        if (this._serverSubs.hasOwnProperty(channel)) {
          this.emit('unsubscribe', { channel: channel });
        }
      }
      const ctx = {
        reason: reason,
        reconnect: reconnect
      };
      if (this._config.protocolVersion === 'v2') {
        ctx['code'] = code;
      }
      if (!isInitialHandshake) {
        this.emit('disconnect', ctx);
      }
    }

    if (reconnect === false) {
      this._subs = {};
      this._serverSubs = {};
    }

    if (this._transport && !this._transportClosed) {
      this._transport.close();
    }
  };

  _refreshFailed() {
    this._numRefreshFailed = 0;
    if (!this._isDisconnected()) {
      this._disconnect(7, 'refresh failed', false);
    }
    if (this._config.onRefreshFailed !== null) {
      this._config.onRefreshFailed();
    }
  };

  _refresh() {
    // ask application for new connection token.
    this._debug('refresh token');

    if (this._config.refreshAttempts === 0) {
      this._debug('refresh attempts set to 0, do not send refresh request at all');
      this._refreshFailed();
      return;
    }

    if (this._refreshTimeout !== null) {
      clearTimeout(this._refreshTimeout);
      this._refreshTimeout = null;
    }

    const clientID = this._clientID;
    const xhrID = this._newXHRID();

    const cb = (resp) => {
      if (xhrID in this._xhrs) {
        delete this._xhrs[xhrID];
      }
      if (this._clientID !== clientID) {
        return;
      }
      if (resp.error || resp.status !== 200) {
        // We don't perform any connection status related actions here as we are
        // relying on server that must close connection eventually.
        if (resp.error) {
          this._debug('error refreshing connection token', resp.error);
        } else {
          this._debug('error refreshing connection token: wrong status code', resp.status);
        }
        this._numRefreshFailed++;
        if (this._refreshTimeout !== null) {
          clearTimeout(this._refreshTimeout);
          this._refreshTimeout = null;
        }
        if (this._config.refreshAttempts !== null && this._numRefreshFailed >= this._config.refreshAttempts) {
          this._refreshFailed();
          return;
        }
        const jitter = Math.round(Math.random() * 1000 * Math.max(this._numRefreshFailed, 20));
        const interval = this._config.refreshInterval + jitter;
        this._refreshTimeout = setTimeout(() => this._refresh(), interval);
        return;
      }
      this._numRefreshFailed = 0;
      this._token = resp.data.token;
      if (!this._token) {
        this._refreshFailed();
        return;
      }
      if (this._isDisconnected() && this._reconnect) {
        this._debug('token refreshed, connect from scratch');
        this._connect();
      } else {
        this._debug('send refreshed token');
        const req = { token: this._token };
        const msg = {};
        if (this._config.protocolVersion === 'v2') {
          msg.refresh = req;
        } else {
          msg.method = this._methodType.REFRESH;
          msg.params = req;
        }

        const self = this;

        this._call(msg).then(resolveCtx => {
          let result;
          if (self._config.protocolVersion === 'v1') {
            result = self._decoder.decodeCommandResult(self._methodType.REFRESH, resolveCtx.reply.result);
          } else {
            result = resolveCtx.reply.refresh;
          }
          this._refreshResponse(result);
          if (resolveCtx.next) {
            resolveCtx.next();
          }
        }, rejectCtx => {
          this._refreshError(rejectCtx.error);
          if (rejectCtx.next) {
            rejectCtx.next();
          }
        });
      }
    };

    if (this._config.onRefresh !== null) {
      const context = {};
      this._config.onRefresh(context, cb);
    } else {
      const xhr = this._ajax(
        this._config.refreshEndpoint,
        this._config.refreshParams,
        this._config.refreshHeaders,
        this._config.refreshData,
        cb
      );
      this._xhrs[xhrID] = xhr;
    }
  };

  _refreshError(err) {
    this._debug('refresh error', err);
    if (this._refreshTimeout) {
      clearTimeout(this._refreshTimeout);
      this._refreshTimeout = null;
    }
    const interval = this._config.refreshInterval + Math.round(Math.random() * 1000);
    this._refreshTimeout = setTimeout(() => this._refresh(), interval);
  }

  _refreshResponse(result) {
    if (this._refreshTimeout) {
      clearTimeout(this._refreshTimeout);
      this._refreshTimeout = null;
    }
    if (result.expires) {
      this._clientID = result.client;
      this._refreshTimeout = setTimeout(() => this._refresh(), this._getTTLMilliseconds(result.ttl));
    }
  };

  _newXHRID() {
    this._xhrID++;
    return this._xhrID;
  }

  _subRefresh(channel) {
    this._debug('refresh subscription token for channel', channel);

    if (this._subRefreshTimeouts[channel] !== undefined) {
      this._clearSubRefreshTimeout(channel);
    } else {
      return;
    }

    const clientID = this._clientID;
    const xhrID = this._newXHRID();

    const cb = (resp) => {
      if (xhrID in this._xhrs) {
        delete this._xhrs[xhrID];
      }
      if (resp.error || resp.status !== 200 || this._clientID !== clientID) {
        return;
      }
      let channelsData = {};
      if (resp.data.channels) {
        for (const i in resp.data.channels) {
          const channelData = resp.data.channels[i];
          if (!channelData.channel) {
            continue;
          }
          channelsData[channelData.channel] = channelData.token;
        }
      }

      const token = channelsData[channel];
      if (!token) {
        return;
      }

      const sub = this._getSub(channel);
      if (sub === null) {
        return;
      }

      const req = {
        channel: channel,
        token: token
      };
      const msg = {};

      if (this._config.protocolVersion === 'v2') {
        msg['sub_refresh'] = req;
      } else {
        msg.method = this._methodType.SUB_REFRESH;
        msg.params = req;
      }

      const self = this;

      this._call(msg).then(resolveCtx => {
        let result;
        if (self._config.protocolVersion === 'v1') {
          result = self._decoder.decodeCommandResult(self._methodType.SUB_REFRESH, resolveCtx.reply.result);
        } else {
          result = resolveCtx.reply.sub_refresh;
        }
        this._subRefreshResponse(channel, result);
        if (resolveCtx.next) {
          resolveCtx.next();
        }
      }, rejectCtx => {
        this._subRefreshError(channel, rejectCtx.error);
        if (rejectCtx.next) {
          rejectCtx.next();
        }
      });
    };

    const data = {
      client: this._clientID,
      channels: [channel]
    };

    if (this._config.onPrivateSubscribe !== null) {
      this._config.onPrivateSubscribe({
        data: data
      }, cb);
    } else {
      const xhr = this._ajax(
        this._config.subscribeEndpoint, this._config.subscribeParams, this._config.subscribeHeaders, data, cb);
      this._xhrs[xhrID] = xhr;
    }
  };

  _clearSubRefreshTimeout(channel) {
    if (this._subRefreshTimeouts[channel] !== undefined) {
      clearTimeout(this._subRefreshTimeouts[channel]);
      delete this._subRefreshTimeouts[channel];
    }
  }

  _subRefreshError(channel, err) {
    this._debug('subscription refresh error', channel, err);
    this._clearSubRefreshTimeout(channel);
    const sub = this._getSub(channel);
    if (sub === null) {
      return;
    }
    const jitter = Math.round(Math.random() * 1000);
    let subRefreshTimeout = setTimeout(() => this._subRefresh(channel), this._config.subRefreshInterval + jitter);
    this._subRefreshTimeouts[channel] = subRefreshTimeout;
    return;
  }

  _subRefreshResponse(channel, result) {
    this._debug('subscription refresh success', channel);
    this._clearSubRefreshTimeout(channel);
    const sub = this._getSub(channel);
    if (sub === null) {
      return;
    }
    if (result.expires === true) {
      let subRefreshTimeout = setTimeout(() => this._subRefresh(channel), this._getTTLMilliseconds(result.ttl));
      this._subRefreshTimeouts[channel] = subRefreshTimeout;
    }
    return;
  };

  _subscribe(sub, isResubscribe) {
    this._debug('subscribing on', sub.channel);
    const channel = sub.channel;

    if (!(channel in this._subs)) {
      this._subs[channel] = sub;
    }

    if (!this.isConnected()) {
      // subscribe will be called later
      sub._setNew();
      return;
    }

    sub._setSubscribing(isResubscribe);

    const req = {
      channel: channel
    };

    if (sub._subscribeData) {
      req.data = sub._subscribeData;
    }

    // If channel name does not start with privateChannelPrefix - then we
    // can just send subscription message to Centrifuge. If channel name
    // starts with privateChannelPrefix - then this is a private channel
    // and we should ask web application backend for permission first.
    if (startsWith(channel, this._config.privateChannelPrefix)) {
      // private channel.
      if (this._isSubscribeBatching) {
        this._privateChannels[channel] = true;
      } else {
        this.startSubscribeBatching();
        this._subscribe(sub);
        this.stopSubscribeBatching();
      }
    } else {
      const recover = sub._needRecover();

      if (recover === true) {
        req.recover = true;
        const seq = this._getLastSeq(channel);
        const gen = this._getLastGen(channel);
        if (seq || gen) {
          if (seq) {
            req.seq = seq;
          }
          if (gen) {
            req.gen = gen;
          }
        } else {
          const offset = this._getLastOffset(channel);
          if (offset) {
            req.offset = offset;
          }
        }
        const epoch = this._getLastEpoch(channel);
        if (epoch) {
          req.epoch = epoch;
        }
      }

      const msg = {};
      if (this._config.protocolVersion === 'v2') {
        msg.subscribe = req;
      } else {
        msg.method = this._methodType.SUBSCRIBE;
        msg.params = req;
      }

      this._call(msg).then(resolveCtx => {
        let result;
        if (this._config.protocolVersion === 'v1') {
          result = this._decoder.decodeCommandResult(this._methodType.SUBSCRIBE, resolveCtx.reply.result);
        } else {
          result = resolveCtx.reply.subscribe;
        }
        this._subscribeResponse(
          channel,
          recover,
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
  };

  _removeSubscription(sub) {
    delete this._subs[sub.channel];
  }

  _unsubscribe(sub) {
    this._removeSubscription(sub);
    delete this._lastOffset[sub.channel];
    delete this._lastSeq[sub.channel];
    delete this._lastGen[sub.channel];
    if (this.isConnected()) {
      // No need to unsubscribe in disconnected state - i.e. client already unsubscribed.
      const req = {
        channel: sub.channel
      };
      const msg = {};
      if (this._config.protocolVersion === 'v2') {
        msg.unsubscribe = req;
      } else {
        msg.method = this._methodType.UNSUBSCRIBE;
        msg.params = req;
      }
      this._addMessage(msg);
    }
  };

  _getTTLMilliseconds(ttl) {
    // https://stackoverflow.com/questions/12633405/what-is-the-maximum-delay-for-setinterval
    return Math.min(ttl * 1000, 2147483647);
  }

  getSub(channel) {
    return this._getSub(channel);
  }

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
    const wasReconnecting = this._reconnecting;
    this._transportWasOpen = true;
    this._reconnecting = false;
    this._resetRetry();
    this._refreshRequired = false;

    if (this.isConnected()) {
      return;
    }

    if (this._latencyStart !== null) {
      this._latency = (new Date()).getTime() - this._latencyStart.getTime();
      this._latencyStart = null;
    }

    this._clientID = result.client;
    this._setState(states.CONNECTED);

    if (this._refreshTimeout) {
      clearTimeout(this._refreshTimeout);
    }

    if (result.expires) {
      this._refreshTimeout = setTimeout(() => this._refresh(), this._getTTLMilliseconds(result.ttl));
    }

    this._session = result.session;
    this._node = result.node;

    this.startBatching();
    this.startSubscribeBatching();
    for (const channel in this._subs) {
      if (this._subs.hasOwnProperty(channel)) {
        const sub = this._subs[channel];
        if (sub._shouldResubscribe()) {
          this._subscribe(sub, wasReconnecting);
        }
      }
    }
    this.stopSubscribeBatching();
    this.stopBatching();

    const ctx = {
      client: result.client,
      transport: this._transport.subName(),
      latency: this._latency
    };
    if (result.data) {
      ctx.data = result.data;
    }

    this.emit('connect', ctx);

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
        const isResubscribe = this._serverSubs[channel] !== undefined;
        let subCtx = { channel: channel, isResubscribe: isResubscribe };
        subCtx = this._expandSubscribeContext(subCtx, sub);
        this.emit('subscribe', subCtx);
      }
    }
    for (const channel in subs) {
      if (subs.hasOwnProperty(channel)) {
        const sub = subs[channel];
        if (sub.recovered) {
          let pubs = sub.publications;
          if (pubs && pubs.length > 0) {

            // handle legacy order.
            // TODO: remove as soon as Centrifuge v1 released.
            if (pubs.length > 1 && (!pubs[0].offset || pubs[0].offset > pubs[1].offset)) {
              pubs = pubs.reverse();
            }

            for (let i in pubs) {
              if (pubs.hasOwnProperty(i)) {
                this._handlePublication(channel, pubs[i]);
              }
            }
          }
        }
        this._serverSubs[channel] = {
          'seq': sub.seq,
          'gen': sub.gen,
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
    if (!this.isConnected()) {
      return;
    }
    if (this._serverPingTimeout) {
      clearTimeout(this._serverPingTimeout);
    }
    this._serverPingTimeout = setTimeout(() => {
      if (!this.isConnected()) {
        this._stopPing();
        return;
      }
      this._disconnect(11, 'no ping', true);
    }, this._serverPing + this._config.maxServerPingDelay);
  };

  _startClientPing() {
    if (this._config.ping !== true || this._config.pingInterval <= 0) {
      return;
    }
    if (!this.isConnected()) {
      return;
    }

    this._pingTimeout = setTimeout(() => {
      if (!this.isConnected()) {
        this._stopPing();
        return;
      }
      this.ping();
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
    if (error.code === 0 && error.message === _errorTimeout) { // client side timeout.
      this._disconnect(10, 'subscribe timeout', true);
      return;
    }
    sub._setSubscribeError(error);
  };

  _expandSubscribeContext(ctx, result) {
    let recovered = false;
    if ('recovered' in result) {
      recovered = result.recovered;
    }
    ctx.recovered = recovered;

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

  _subscribeResponse(channel, isRecover, result) {
    const sub = this._getSub(channel);
    if (!sub) {
      return;
    }
    if (!sub._isSubscribing()) {
      return;
    }
    sub._setSubscribeSuccess(result);

    let pubs = result.publications;
    if (pubs && pubs.length > 0) {
      if (pubs.length >= 2 && !pubs[0].offset && !pubs[1].offset) {
        // handle legacy order.
        pubs = pubs.reverse();
      }
      for (let i in pubs) {
        if (pubs.hasOwnProperty(i)) {
          this._handlePublication(channel, pubs[i]);
        }
      }
    }

    if (result.recoverable && (!isRecover || !result.recovered)) {
      this._lastSeq[channel] = result.seq || 0;
      this._lastGen[channel] = result.gen || 0;
      this._lastOffset[channel] = result.offset || 0;
    }

    this._lastEpoch[channel] = result.epoch || '';

    if (result.recoverable) {
      sub._recoverable = true;
    }

    if (result.expires === true) {
      let subRefreshTimeout = setTimeout(() => this._subRefresh(channel), this._getTTLMilliseconds(result.ttl));
      this._subRefreshTimeouts[channel] = subRefreshTimeout;
    }
  };

  _handleReply(reply, next) {
    const id = reply.id;

    console.log(id);
    console.log(this._callbacks);

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
    const ctx = { 'info': join.info };
    const sub = this._getSub(channel);
    if (!sub) {
      if (this._isServerSub(channel)) {
        ctx.channel = channel;
        this.emit('join', ctx);
      }
      return;
    }
    sub.emit('join', ctx);
  };

  _handleLeave(channel, leave) {
    const ctx = { 'info': leave.info };
    const sub = this._getSub(channel);
    if (!sub) {
      if (this._isServerSub(channel)) {
        ctx.channel = channel;
        this.emit('leave', ctx);
      }
      return;
    }
    sub.emit('leave', ctx);
  };

  _handleUnsub(channel, unsub) {
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
    let clearSubscribedState;
    if (this._config.protocolVersion === 'v1') {
      clearSubscribedState = true;
    } else {
      clearSubscribedState = unsub.type !== 1;
    }
    sub._setUnsubscribed(clearSubscribedState);
    if (this._config.protocolVersion === 'v2' && unsub.type === 1) {
      sub._recover = true;
      sub.subscribe();
    }
  };

  _handleSub(channel, sub) {
    this._serverSubs[channel] = {
      'seq': sub.seq,
      'gen': sub.gen,
      'offset': sub.offset,
      'epoch': sub.epoch,
      'recoverable': sub.recoverable
    };
    let ctx = { 'channel': channel, isResubscribe: false };
    ctx = this._expandSubscribeContext(ctx, sub);
    this.emit('subscribe', ctx);
  };

  _handleDisconnect(disconnect) {
    const code = disconnect.code;
    let needReconnect = true;
    if ((code >= 3500 && code < 4000) || (code >= 4500 && code < 5000)) {
      needReconnect = false;
    }
    this._disconnect(code, disconnect.reason, needReconnect);
  };

  _handlePublication(channel, pub) {
    const sub = this._getSub(channel);
    const ctx = {
      'data': pub.data,
      'seq': pub.seq,
      'gen': pub.gen,
      'offset': pub.offset
    };
    if (pub.info) {
      ctx.info = pub.info;
    }
    if (pub.tags) {
      ctx.tags = pub.tags;
    }
    if (!sub) {
      if (this._isServerSub(channel)) {
        if (pub.seq !== undefined) {
          this._serverSubs[channel].seq = pub.seq;
        }
        if (pub.gen !== undefined) {
          this._serverSubs[channel].gen = pub.gen;
        }
        if (pub.offset !== undefined) {
          this._serverSubs[channel].offset = pub.offset;
        }
        ctx.channel = channel;
        this.emit('publish', ctx);
      }
      return;
    }
    if (pub.seq !== undefined) {
      this._lastSeq[channel] = pub.seq;
    }
    if (pub.gen !== undefined) {
      this._lastGen[channel] = pub.gen;
    }
    if (pub.offset !== undefined) {
      this._lastOffset[channel] = pub.offset;
    }
    sub.emit('publish', ctx);
  };

  _handleMessage(message) {
    this.emit('message', message.data);
  };

  _handlePush(data, next) {
    const push = this._decoder.decodePush(data);
    let type = 0;
    if ('type' in push) {
      type = push['type'];
    }
    const channel = push.channel;

    if (type === this._pushType.PUBLICATION) {
      const pub = this._decoder.decodePushData(this._pushType.PUBLICATION, push.data);
      this._handlePublication(channel, pub);
    } else if (type === this._pushType.MESSAGE) {
      const message = this._decoder.decodePushData(this._pushType.MESSAGE, push.data);
      this._handleMessage(message);
    } else if (type === this._pushType.JOIN) {
      const join = this._decoder.decodePushData(this._pushType.JOIN, push.data);
      this._handleJoin(channel, join);
    } else if (type === this._pushType.LEAVE) {
      const leave = this._decoder.decodePushData(this._pushType.LEAVE, push.data);
      this._handleLeave(channel, leave);
    } else if (type === this._pushType.UNSUBSCRIBE) {
      const unsub = this._decoder.decodePushData(this._pushType.UNSUBSCRIBE, push.data);
      this._handleUnsub(channel, unsub);
    } else if (type === this._pushType.SUBSCRIBE) {
      const sub = this._decoder.decodePushData(this._pushType.UNSUBSCRIBE, push.data);
      this._handleSub(channel, sub);
    }
    next();
  }

  _handleServerPing(next) {
    if (this._sendPong) {
      const msg = {};
      this._transportSend([msg]);
    }
    next();
  }

  _handlePushV2(data, next) {
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
      this._handleUnsub(channel, data.unsubscribe);
    } else if (data.subscribe) {
      this._handleSub(channel, data.subscribe);
    } else if (data.disconnect) {
      this._handleDisconnect(data.disconnect);
    }
    next();
  }

  _flush() {
    const messages = this._messages.slice(0);
    this._messages = [];
    this._transportSend(messages);
  };

  _ping() {
    const msg = {};
    if (this._config.protocolVersion === 'v2') {
      // v2 does not require any additional data for pings;
    } else {
      msg.method = this._methodType.PING;
    }
    this._call(msg).then(resolveCtx => {
      this._pingResponse(this._decoder.decodeCommandResult(this._methodType.PING, resolveCtx.result));
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

  _pingResponse(result) {
    if (!this.isConnected()) {
      return;
    }
    this._stopPing();
    this._startClientPing();
  }

  _getLastSeq(channel) {
    const lastSeq = this._lastSeq[channel];
    if (lastSeq) {
      return lastSeq;
    }
    return 0;
  };

  _getLastOffset(channel) {
    const lastOffset = this._lastOffset[channel];
    if (lastOffset) {
      return lastOffset;
    }
    return 0;
  };

  _getLastGen(channel) {
    const lastGen = this._lastGen[channel];
    if (lastGen) {
      return lastGen;
    }
    return 0;
  };

  _getLastEpoch(channel) {
    const lastEpoch = this._lastEpoch[channel];
    if (lastEpoch) {
      return lastEpoch;
    }
    return '';
  };

  _createErrorObject(message, code) {
    const errObject = {
      message: message,
      code: code || 0
    };

    return errObject;
  };

  _registerCall(id, callback, errback) {
    this._callbacks[id] = {
      callback: callback,
      errback: errback,
      timeout: null
    };
    console.log(this._callbacks[id]);
    this._callbacks[id].timeout = setTimeout(() => {
      delete this._callbacks[id];
      if (isFunction(errback)) {
        errback({ error: this._createErrorObject(_errorTimeout) });
      }
    }, this._config.timeout);
  };

  _addMessage(message) {
    let id = this._nextMessageId();
    message.id = id;
    if (this._isBatching === true) {
      this._messages.push(message);
    } else {
      this._transportSend([message]);
    }
    return id;
  };

  isConnected() {
    return this._isConnected();
  }

  connect() {
    this._connect();
  };

  disconnect() {
    this._disconnect(0, 'client', false);
  };

  ping() {
    return this._ping();
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

  startSubscribeBatching() {
    // start collecting private channels to create bulk authentication
    // request to subscribeEndpoint when stopSubscribeBatching will be called
    this._isSubscribeBatching = true;
  };

  stopSubscribeBatching() {
    // create request to subscribeEndpoint with collected private channels
    // to ask if this client can subscribe on each channel
    this._isSubscribeBatching = false;
    const authChannels = this._privateChannels;
    this._privateChannels = {};

    const channels = [];

    for (const channel in authChannels) {
      if (authChannels.hasOwnProperty(channel)) {
        const sub = this._getSub(channel);
        if (!sub) {
          continue;
        }
        channels.push(channel);
      }
    }

    if (channels.length === 0) {
      this._debug('no private channels found, no need to make request');
      return;
    }

    const data = {
      client: this._clientID,
      channels: channels
    };

    const clientID = this._clientID;
    const xhrID = this._newXHRID();

    const cb = (resp) => {
      if (xhrID in this._xhrs) {
        delete this._xhrs[xhrID];
      }
      if (this._clientID !== clientID) {
        return;
      }
      if (resp.error || resp.status !== 200) {
        this._debug('authorization request failed');
        for (const i in channels) {
          if (channels.hasOwnProperty(i)) {
            const channel = channels[i];
            this._subscribeError(channel, this._createErrorObject('authorization request failed'));
          }
        }
        return;
      }

      let channelsData = {};
      if (resp.data.channels) {
        for (const i in resp.data.channels) {
          const channelData = resp.data.channels[i];
          if (!channelData.channel) {
            continue;
          }
          channelsData[channelData.channel] = channelData.token;
        }
      }

      // try to send all subscriptions in one request.
      let batch = false;

      if (!this._isBatching) {
        this.startBatching();
        batch = true;
      }

      for (const i in channels) {
        if (channels.hasOwnProperty(i)) {
          const channel = channels[i];
          const token = channelsData[channel];

          if (!token) {
            // subscription:error
            this._subscribeError(channel, this._createErrorObject('permission denied', 103));
            continue;
          } else {
            const sub = this._getSub(channel);
            if (sub === null) {
              continue;
            }

            const req = {
              channel: channel,
              token: token
            };

            const recover = sub._needRecover();

            if (recover === true) {
              req.recover = true;
              const seq = this._getLastSeq(channel);
              const gen = this._getLastGen(channel);
              if (seq || gen) {
                if (seq) {
                  req.seq = seq;
                }
                if (gen) {
                  req.gen = gen;
                }
              } else {
                const offset = this._getLastOffset(channel);
                if (offset) {
                  req.offset = offset;
                }
              }
              const epoch = this._getLastEpoch(channel);
              if (epoch) {
                req.epoch = epoch;
              }
            }
            const msg = {};
            if (this._config.protocolVersion === 'v2') {
              msg.subscribe = req;
            } else {
              msg.method = this._methodType.SUBSCRIBE;
              msg.params = req;
            }
            this._call(msg).then(resolveCtx => {
              let result;
              if (this._config.protocolVersion === 'v1') {
                result = this._decoder.decodeCommandResult(this._methodType.SUBSCRIBE, resolveCtx.reply.result);
              } else {
                result = resolveCtx.reply.subscribe;
              }
              this._subscribeResponse(
                channel,
                recover,
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
        }
      }

      if (batch) {
        this.stopBatching();
      }

    };

    if (this._config.onPrivateSubscribe !== null) {
      this._config.onPrivateSubscribe({
        data: data
      }, cb);
    } else {
      const xhr = this._ajax(
        this._config.subscribeEndpoint, this._config.subscribeParams, this._config.subscribeHeaders, data, cb);
      this._xhrs[xhrID] = xhr;
    }
  };

  _setSubscribeSince(sub, since) {
    this._lastOffset[sub.channel] = since.offset;
    this._lastEpoch[sub.channel] = since.epoch;
    sub._setNeedRecover(true);
  }

  subscribe(channel, events, opts) {
    const currentSub = this._getSub(channel);
    if (currentSub !== null) {
      currentSub._setEvents(events);
      if (currentSub._isUnsubscribed()) {
        currentSub.subscribe(opts);
      }
      return currentSub;
    }
    const sub = new Subscription(this, channel, events);
    this._subs[channel] = sub;
    sub.subscribe(opts);
    return sub;
  };
}
