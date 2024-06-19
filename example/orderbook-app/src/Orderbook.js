// examples/orderbook-app/src/Orderbook.js
import React, { useEffect, useState, useRef } from "react";
import { Centrifuge } from "centrifuge";

const Orderbook = () => {
  const [bids, setBids] = useState([]);
  const [asks, setAsks] = useState([]);
  const centrifugeRef = useRef(null);
  const lastSeqRef = useRef(0);

  useEffect(() => {
    const centrifuge = new Centrifuge("wss://api.testnet.rabbitx.io/ws", {
      token: "your-jwt-token",
    });

    centrifugeRef.current = centrifuge;

    const subscription = centrifuge.newSubscription("orderbook_channel");

    subscription.on("publication", (ctx) => {
      const data = ctx.data;
      if (data.sequence <= lastSeqRef.current) {
        return; // Skip old or duplicate updates
      }
      lastSeqRef.current = data.sequence;

      if (data.bids) {
        setBids((prevBids) => mergeOrderbook(prevBids, data.bids));
      }
      if (data.asks) {
        setAsks((prevAsks) => mergeOrderbook(prevAsks, data.asks));
      }
    });

    subscription.subscribe();
    centrifuge.connect();

    centrifuge.on("disconnected", () => {
      subscription.unsubscribe();
      lastSeqRef.current = 0;
    });

    return () => {
      subscription.unsubscribe();
      centrifuge.disconnect();
    };
  }, []);

  const mergeOrderbook = (current, updates) => {
    const updatedOrderbook = [...current];

    updates.forEach((update) => {
      const index = updatedOrderbook.findIndex(
        (item) => item.price === update.price
      );
      if (update.size === 0) {
        if (index !== -1) {
          updatedOrderbook.splice(index, 1);
        }
      } else {
        if (index !== -1) {
          updatedOrderbook[index] = update;
        } else {
          updatedOrderbook.push(update);
        }
      }
    });

    return updatedOrderbook.sort((a, b) => b.price - a.price);
  };

  return (
    <div>
      <h2>Orderbook</h2>
      <div className="orderbook">
        <div className="bids">
          <h3>Bids</h3>
          <ul>
            {bids.map((bid, index) => (
              <li key={index}>
                Price: {bid.price}, Size: {bid.size}
              </li>
            ))}
          </ul>
        </div>
        <div className="asks">
          <h3>Asks</h3>
          <ul>
            {asks.map((ask, index) => (
              <li key={index}>
                Price: {ask.price}, Size: {ask.size}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
};

export default Orderbook;
