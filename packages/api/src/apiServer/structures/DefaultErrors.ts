import { ValidationReport, Validator } from "../helper/Validator"
import { IError } from "./Interfaces"

class DefaultErrors{
    static NOT_IMPLEMENTED:IError=          {code:1,message:"Not implemented"}
    static UNKNOWN_REQUEST:IError=          {code:2,message:"Unknown request"}
    static JSON_MALFORMED:IError=           {code:3,message:"JSON malformed"}
    static FILE_TOO_LARGE:IError=           {code:4,message:"File is too large",httpStatus:413}
    static CANT_SEND_FILE:IError=           {code:5,message:"Can't send file"}
    static FILE_NOT_EXISTS:IError=          {code:5,message:"File not exists",httpStatus:404}
    static UNAUTHORIZED:IError=             {code:6,message:"Unauthorized",httpStatus:401}
    static BAD_REQUEST:IError=              {code:7,message:"Bad request",httpStatus:400}
    static SERVICE_NOT_WORKING:IError=      {code:8,message:"Service not working"}
    static TIMEOUT:IError=                  {code:9,message:"Timeout",httpStatus:408}
    static METHOD_NOT_ALLOWED:IError=       {code:10,message:"Method not allowed",httpStatus:405}
    static DB_ERROR:IError=                 {code:11,message:"DB error",httpStatus:500}
    static DB_DUPLICATE_ERROR:IError=       {code:28,message:"DB duplicate entry",httpStatus:409}
    static FORBIDDEN:IError=                {code:12,message:"Forbidden",httpStatus:403}
    static NOT_FOUND:IError=                {code:13,message:"Not found",httpStatus:404}
    static INTERNAL_SERVER_ERROR:IError=    {code:14,message:"Internal server error.",httpStatus:500}
    static INVALID_TOKEN:IError=            {code:15,message:"Invalid token",httpStatus:401}
    static INVALID_CREDENTIALS:IError=      {code:16,message:"Invalid credentials",httpStatus:401}
    static INVALID_DATA:IError=             {code:17,message:"Invalid data",httpStatus:422}
    static INVALID_FILE:IError=             {code:18,message:"Invalid file",httpStatus:422}
    static EXTERNAL_SERVICE_ERROR:IError=   {code:19,message:"External service error",httpStatus:502}
    static MAINTENANCE_MODE:IError=         {code:21,message:"Service in maintenance mode",httpStatus:503}
    static CONFLICT:IError=                 {code:22,message:"Conflict",httpStatus:409}
    static WRONG_DATA_TYPE:IError=          {code:23,message:"Wrong data type",httpStatus:422}
    static UPROCESSIABLE_CONTENT:IError=    {code:24,message:"Unprocessable content",httpStatus:422}
    static WRONG_PARAMS:IError=             {code:25,message:"Wrong params",httpStatus:400}
    static ACCEPTED:IError=                 {code:26,message:"Accepted",httpStatus:202}
    static INTERNAL_ERROR:IError=           {code:27,message:"Internal error",httpStatus:500}
}

export class ErrorUtils{

    static isError(obj:any):obj is IError{
        const isFieldsExists = Validator.validateObject(['code','message'],obj)
    
        if(!isFieldsExists)
            return false;
    
        if(Validator.validateValue(obj.code,{type:"number"})!==ValidationReport.OK)
            return false;
    
        if(Validator.validateValue(obj.message,{type:"string"})!==ValidationReport.OK)
            return false;
    
        return true;
    }

    static appendStack(error:IError,stack?:IError[]):IError{
        error.stack = stack;
        return error;
    }
}

export default DefaultErrors