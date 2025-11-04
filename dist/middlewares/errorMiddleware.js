"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notFound = exports.errorHandler = void 0;
const errorHandler = (err, req, res, next) => {
    const statusCode = res.statusCode || 500;
    res.status(statusCode).json({
        success: false,
        message: err.message,
        statusCode,
        stack: process.env.NODE_ENV == "development" ? err.stack : null
    });
};
exports.errorHandler = errorHandler;
const notFound = (req, res, next) => {
    const error = new Error(`That route does not exist - ${req.originalUrl}`);
    res.status(404);
    next();
};
exports.notFound = notFound;
