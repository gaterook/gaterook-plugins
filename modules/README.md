# Connector modules

`index.json` and `index.json.sig` in this folder are the list of GateRook's own connector modules. The release tooling writes them: never edit them by hand.

A release of GateRook reads the list from `https://raw.githubusercontent.com/gaterook/gaterook-plugins/main/modules/` and trusts it only under the key `modules-2026-1` of [`keys.json`](../keys.json).

An entry names one version of one module: the application versions it runs with, its package's address, size and SHA-256, and the connector types it adds. See [connector delivery](https://github.com/gaterook/gaterook/blob/main/docs/connector-delivery.md).
