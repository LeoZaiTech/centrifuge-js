import React, { useEffect, useState, useRef } from "react";
import { Centrifuge } from "centrifuge";

const Orderbook = () => {
  const [bids, setBids] = useState([]);
  const [asks, setAsks] = useState([]);
  const [rawData, setRawData] = useState(null);
  const centrifugeRef = useRef(null);
  const lastSeqRef = useRef(0);

  useEffect(() => {
    // Check if a WebSocket connection already exists
    if (centrifugeRef.current) {
      console.log("WebSocket connection already exists.");
      return;
    }

    // Initialize Centrifuge with the WebSocket URL and token
    const centrifuge = new Centrifuge(
      "wss://api.testnet.rabbitx.io/ws", // Use 'wss' for secure connection
      {
        token:
          "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwIiwiZXhwIjo1MjYyNjUyMDEwfQ.x_245iYDEvTTbraw1gt4jmFRFfgMJb-GJ-hsU9HuDik",
        debug: true,
      }
    );

    centrifugeRef.current = centrifuge;

    // Subscribe to the orderbook channel
    const subscription = centrifuge.newSubscription("orderbook:BTC-USD");

    // Handle incoming WebSocket publications
    subscription.on("publication", (ctx) => {
      console.log("Publication received:", ctx);
      const data = ctx.data;
      setRawData(data); // Store the raw data to display in the UI
      console.log("Received Data:", data);

      // Skip old or duplicate updates based on sequence number
      if (data.sequence <= lastSeqRef.current) {
        console.log("Skipping old or duplicate update.");
        return;
      }
      lastSeqRef.current = data.sequence;

      // Convert the bids and asks arrays to objects for easier processing
      const parsedBids = data.bids.map(([price, size]) => ({ price, size }));
      const parsedAsks = data.asks.map(([price, size]) => ({ price, size }));

      console.log("Parsed Bids:", parsedBids);
      console.log("Parsed Asks:", parsedAsks);

      // Merge the new bids and asks with the existing ones
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

    // Handle subscription errors
    subscription.on("error", (error) => {
      console.error("Subscription error:", error);
    });

    // Handle Centrifuge errors
    centrifuge.on("error", (error) => {
      console.error("Centrifuge error:", error);
    });

    // Subscribe and connect to the WebSocket
    subscription.subscribe();
    centrifuge.connect();

    // Handle WebSocket connection events
    centrifuge.on("connected", () => {
      console.log("Connected to WebSocket");
    });

    // Handle WebSocket disconnection events
    centrifuge.on("disconnected", (ctx) => {
      console.log("Disconnected from WebSocket", ctx);
      subscription.unsubscribe();
      lastSeqRef.current = 0;
      reconnect();
    });

    // Reconnect function to handle reconnections
    const reconnect = () => {
      setTimeout(() => {
        console.log("Attempting to reconnect...");
        centrifuge.connect();
      }, 3000); // Reconnect after 3 seconds
    };

    // Cleanup function to unsubscribe and disconnect on component unmount
    return () => {
      subscription.unsubscribe();
      centrifuge.disconnect();
    };
  }, []);

  // Function to merge the current orderbook with updates
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
