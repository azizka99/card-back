import { Request, Response, NextFunction } from "express";


interface CustomError {
    message: string;
    stack: string;
}


const errorHandler = (err: CustomError, req: Request, res: Response, next: NextFunction) => {
    const statusCode = res.statusCode || 500;

    res.status(statusCode).json({
        success: false,
        message: err.message,
        statusCode,
        stack: process.env.NODE_ENV == "development" ? err.stack : null
    });
}

const notFound = (req:Request,res:Response, next:NextFunction)=>{
    const error = new Error(`That route does not exist - ${req.originalUrl}`);
    res.status(404);
    next();
}

export {errorHandler, notFound};