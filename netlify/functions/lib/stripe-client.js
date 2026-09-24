"use strict";

const Stripe = require("stripe");

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { apiVersion: "2024-11-20.acacia" });
}

function stripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

module.exports = { getStripe, stripeConfigured };
