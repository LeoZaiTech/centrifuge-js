//Most Updated and Functioning Solution

import React, { useEffect, useState, useRef } from "react";
import { Centrifuge } from "centrifuge";

const Orderbook = () => {
  const [bids, setBids] = useState([]);
  const [asks, setAsks] = useState([]);
  const [rawData, setRawData] = useState(null);
  const centrifugeRef = useRef(null);
  const lastSeqRef = useRef(0);

  useEffect(() => {
    const centrifuge = new Centrifuge(
      "wss://api.testnet.rabbitx.io/ws", // Use 'wss' for secure connection
      {
        token:
          "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwIiwiZXhwIjo1MjYyNjUyMDEwfQ.x_245iYDEvTTbraw1gt4jmFRFfgMJb-GJ-hsU9HuDik",
        debug: true,
      }
    );

    centrifugeRef.current = centrifuge;

    const subscription = centrifuge.newSubscription("orderbook:BTC-USD");

    subscription.on("publication", (ctx) => {
      console.log("Publication received:", ctx);
      const data = ctx.data;
      setRawData(data); // Store the raw data to display in the UI
      console.log("Received Data:", data);
      if (data.sequence <= lastSeqRef.current) {
        return; // Skip old or duplicate updates
      }
      lastSeqRef.current = data.sequence;

      // Enhanced debugging: Inspect the structure of bids and asks
      console.log("Bids Array:", data.bids);
      console.log("Asks Array:", data.asks);

      // Convert the bids and asks arrays to objects for easier processing
      const parsedBids = data.bids.map(([price, size]) => ({ price, size }));
      const parsedAsks = data.asks.map(([price, size]) => ({ price, size }));

      console.log("Parsed Bids:", parsedBids);
      console.log("Parsed Asks:", parsedAsks);

      setBids((prevBids) => {
        const mergedBids = mergeOrderbook(prevBids, parsedBids);
        console.log("Merged Bids:", mergedBids);
        return mergedBids;
      });

      setAsks((prevAsks) => {
        const mergedAsks = mergeOrderbook(prevAsks, parsedAsks);
        console.log("Merged Asks:", mergedAsks);
        return mergedAsks;
      });
    });

    subscription.on("error", (error) => {
      console.error("Subscription error:", error);
    });

    centrifuge.on("error", (error) => {
      console.error("Centrifuge error:", error);
    });

    subscription.subscribe();
    centrifuge.connect();

    centrifuge.on("connected", () => {
      console.log("Connected to WebSocket");
    });

    centrifuge.on("disconnected", (ctx) => {
      console.log("Disconnected from WebSocket", ctx);
      subscription.unsubscribe();
      lastSeqRef.current = 0;
      reconnect();
    });

    const reconnect = () => {
      setTimeout(() => {
        console.log("Attempting to reconnect...");
        centrifuge.connect();
      }, 3000); // Reconnect after 3 seconds
    };

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
            {bids.length === 0 ? (
              <li>No bids available</li>
            ) : (
              bids.map((bid, index) => (
                <li key={index}>
                  Price: {bid.price}, Size: {bid.size}
                </li>
              ))
            )}
          </ul>
        </div>
        <div className="asks">
          <h3>Asks</h3>
          <ul>
            {asks.length === 0 ? (
              <li>No asks available</li>
            ) : (
              asks.map((ask, index) => (
                <li key={index}>
                  Price: {ask.price}, Size: {ask.size}
                </li>
              ))
            )}
          </ul>
        </div>
      </div>
      <div className="raw-data">
        <h3>Raw Data</h3>
        <pre>{JSON.stringify(rawData, null, 2)}</pre>
      </div>
    </div>
  );
};

export default Orderbook;

//Most Updated and Functioning Solution
