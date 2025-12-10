"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.Tag = void 0;
const dbConnection_1 = __importDefault(require("../constants/dbConnection"));
const isUndefined_1 = __importDefault(require("../helpers/isUndefined"));
const uuid_1 = require("uuid");
const isDate_1 = require("../helpers/isDate");
class Tag {
    constructor(_id, _name, _createdAt, _userId) {
        this.getTag = () => {
            return {
                id: this.id,
                name: this.name,
                created_at: this.created_at
            };
        };
        (0, isUndefined_1.default)({ id: _id }, { name: _name }, { createdAt: _createdAt });
        if (!uuid_1.validate) {
            throw new Error("Invalid UUID format");
        }
        if (_name.length === 0 || _name.length > 100) {
            throw new Error("Name's length should be more than 0 and less than 100");
        }
        if (!(0, isDate_1.isValidDateString)(_createdAt)) {
            throw new Error("This is not a Date!");
        }
        this.id = _id;
        this.name = _name;
        this.created_at = _createdAt;
        if (_userId) {
            this.userId = _userId;
        }
    }
}
exports.Tag = Tag;
_a = Tag;
Tag.createTag = async (tag) => {
    const createdTag = await dbConnection_1.default.tag.create({
        data: {
            id: tag.id,
            name: tag.name,
            created_at: tag.created_at,
            userId: tag.userId
        }
    });
    return createdTag;
};
Tag.findTagById = async (id) => {
    const tag = await dbConnection_1.default.tag.findFirstOrThrow({
        where: {
            id
        }
    });
    return tag;
};
Tag.findTagByUserId = async (userid) => {
    const tags = await dbConnection_1.default.tag.findMany({
        where: {
            userId: userid,
            is_visible_to_user: true
        },
        include: {
            app_user: false,
            _count: {
                select: {
                    steam_card: true
                }
            }
        }
    });
    return tags;
};
Tag.approveByUserById = async (_tag) => {
    const tag = await dbConnection_1.default.tag.update({
        where: {
            id: _tag.id
        },
        data: {
            approved_by_user: true
        },
        include: {
            app_user: true
        }
    });
};
