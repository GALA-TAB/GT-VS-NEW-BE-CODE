// VendorPayout.js — DISABLED
//
// This cron previously performed immediate Stripe transfers upon booking check-in,
// bypassing the 72-hour escrow hold. It has been replaced by PayoutCrone.js which
// only releases funds after the escrow window expires and no dispute is active.
//
// Do not re-enable this file without updating it to respect escrow rules.
