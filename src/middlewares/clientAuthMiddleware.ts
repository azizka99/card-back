import expressAsyncHandler from "express-async-handler";

const clientAuthMiddleWare = expressAsyncHandler(async (req, res, next)=>{

    const token = req.cookies.token;
    const headerToken = req.headers.token;


    if(token || headerToken) {
     console.log('auth exist');
     
    }
});