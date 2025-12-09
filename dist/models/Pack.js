"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.Pack = void 0;
const dbConnection_1 = __importDefault(require("../constants/dbConnection"));
const generateLuhn_1 = require("../helpers/generateLuhn");
const isUndefined_1 = __importDefault(require("../helpers/isUndefined"));
class Pack {
    constructor(_start_number, _id) {
        this.getPack = () => {
            return {
                id: this.id,
                start_number: this.start_number
            };
        };
        (0, isUndefined_1.default)({ start_number: _start_number });
        if (_start_number.length !== 16) {
            throw new Error("Barcode should be 16 digits");
        }
        this.start_number = _start_number;
        this.id = _id;
    }
    ;
}
exports.Pack = Pack;
_a = Pack;
Pack.createPack = async (_pack) => {
    try {
        return await dbConnection_1.default.pack.create({
            data: {
                id: _pack.id,
                start_number: _pack.start_number,
            },
        });
    }
    catch (e) {
        if (e.code === 'P2002') {
            // Unique constraint violation
            const existing = await dbConnection_1.default.pack.findUnique({
                where: { start_number: _pack.start_number },
            });
            return existing;
        }
        throw e;
    }
};
Pack.checkPack = async (_pack) => {
    const expected = (0, generateLuhn_1.generateFixed200)(_pack.start_number);
    const expectedSet = new Set(expected);
    const cards = await dbConnection_1.default.steam_card.findMany({
        where: { pack_id: _pack.id },
        select: {
            id: true,
            barcode: true,
            activation_code: true
        }
    });
    const map = new Map();
    for (const card of cards) {
        if (!map.has(card.barcode)) {
            map.set(card.barcode, []);
        }
        map.get(card.barcode).push(card);
    }
    const missing = [];
    for (const b of expected) {
        if (!map.has(b))
            missing.push(b);
    }
    const extra = [];
    const duplicates = [];
    const matched = [];
    for (const [barcode, group] of map.entries()) {
        const isExpected = expectedSet.has(barcode);
        if (group.length > 1) {
            duplicates.push({
                barcode,
                cards: group
            });
        }
        if (isExpected) {
            matched.push(...group);
        }
        else {
            extra.push(...group);
        }
    }
    return {
        packId: _pack.id,
        totalExpected: expected.length,
        totalFound: cards.length,
        missing,
        extra,
        duplicates,
        matched
    };
};
Pack.findPackById = async (_id) => {
    const pack = await dbConnection_1.default.pack.findUnique({
        where: {
            id: _id
        }
    });
    return pack;
};
