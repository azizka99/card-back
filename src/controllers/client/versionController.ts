import expressAsyncHandler from "express-async-handler";


export const getApiVersion = expressAsyncHandler(async (req, res)=>{
    res.json({
        error:null,
        result: "Version 1.0.0"
    });
});

