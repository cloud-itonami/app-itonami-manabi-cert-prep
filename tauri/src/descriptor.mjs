// kotoba.app.client-runtime.v1 descriptor for the Tauri host. Pure data: tests import it too.
// Every external operation must be declared here with consent "each-operation"; anything
// not declared is refused by the host and blocked by the CSP derived from this file.
// The only operations are the two public reads of the paired education bot.
import { operations } from "./bot-domain.mjs";

export const descriptor = {
  "schema": "kotoba.app.client-runtime.v1",
  "target": "browser",
  "profile": "trusted-page-v1",
  "entry": "index.html",
  "local-state": {
    "adapter": "localstorage",
    "schema": "manabi-cert-prep.sessions.v1",
    "version": 1
  },
  "workers": [],
  "operations": operations
};

export const requestedCapabilities = (d) => [...new Set(d.operations.map((o) => o.capability))];
