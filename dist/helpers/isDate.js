"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidDateString = isValidDateString;
function isValidDateString(str) {
    const d = new Date(str);
    return !isNaN(d.getTime());
}
