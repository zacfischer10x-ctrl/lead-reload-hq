"use strict";

const { getStore, connectLambda } = require("@netlify/blobs");

function ordersStore(event) {
  if (event) connectLambda(event);
  return getStore("lr-orders");
}

function subsStore(event) {
  if (event) connectLambda(event);
  return getStore("lr-subscriptions");
}

async function setJson(store, key, value) {
  if (typeof store.setJSON === "function") {
    await store.setJSON(key, value);
    return;
  }
  await store.set(key, JSON.stringify(value));
}

async function listJson(store) {
  const out = [];
  const listed = await store.list();
  for (const b of listed.blobs || []) {
    const data = await store.get(b.key, { type: "json" });
    if (data) out.push(data);
  }
  return out;
}

module.exports = { ordersStore, subsStore, setJson, listJson };
