"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPoseProvider = getPoseProvider;
const MLKitProvider_1 = require("./providers/MLKitProvider");
let provider = null;
function getPoseProvider() {
    if (!provider) {
        provider = new MLKitProvider_1.MLKitProvider();
    }
    return provider;
}
