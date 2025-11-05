"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.User = void 0;
const dbConnection_1 = __importDefault(require("../constants/dbConnection"));
const isUndefined_1 = __importDefault(require("../helpers/isUndefined"));
const uuid_1 = require("uuid");
const jwt_1 = require("../helpers/jwt");
class User {
    constructor(_id, _email, _name, _role, _password) {
        this.getUser = () => {
            return {
                id: this.id,
                email: this.email,
                name: this.name,
                role: this.role,
                password: this.password
            };
        };
        (0, isUndefined_1.default)({ id: _id }, { email: _email }, { name: _name }, { role: _role });
        if (!(0, uuid_1.validate)(_id)) {
            throw new Error("Invalid UUID format");
        }
        if (_email.length === 0 || _email.length > 255) {
            throw new Error("Email's length should be more than 0 and less than 255");
        }
        if (_name.length === 0 || _name.length > 255) {
            throw new Error("Name's length should be more than 0 and less than 255");
        }
        if (_role !== "client" && _role !== "admin") {
            throw new Error("Role must be either client or admin");
        }
        this.id = _id;
        this.name = _name;
        this.email = _email;
        this.role = _role;
        if (_password) {
            this.password = _password;
        }
    }
    ;
    static signInUser(userid) {
        return (0, jwt_1.signToken)(userid);
    }
    static verifyUser(token) {
        return (0, jwt_1.verifyToken)(token);
    }
}
exports.User = User;
_a = User;
User.findUserByEmail = async (_email) => {
    const _user = await dbConnection_1.default.app_user.findUnique({
        where: {
            email: _email,
            role: "client"
        }
    });
    if (!_user) {
        throw new Error("There is no such user with that email");
    }
    ;
    return new _a(_user.id, _user.email, _user.name, _user.role, _user.password);
};
