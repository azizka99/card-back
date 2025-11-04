"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const isUndefined = (...vars) => {
    vars.forEach(element => {
        for (const [key, value] of Object.entries(element)) {
            if (value === undefined) {
                throw new Error(`${key} is undefined`);
            }
        }
    });
};
exports.default = isUndefined;
