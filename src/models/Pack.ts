import prisma from "../constants/dbConnection";
import { generateFixed200 } from "../helpers/generateLuhn";
import isUndefined from "../helpers/isUndefined";

export class Pack {
    id: string;
    start_number: string;

    constructor(_start_number: string, _id: string) {
        isUndefined({ start_number: _start_number });

        if (_start_number.length !== 16) {
            throw new Error("Barcode should be 16 digits");
        }

        this.start_number = _start_number;
        this.id = _id;
    };

    public getPack = () => {
        return {
            id: this.id,
            start_number: this.start_number
        }
    };

    public static createPack = async (_pack: Pack) => {
        try {
            return await prisma.pack.create({
                data: {
                    id: _pack.id,
                    start_number: _pack.start_number,
                },
            });
        } catch (e: any) {
            if (e.code === 'P2002') {
                // Unique constraint violation
                const existing = await prisma.pack.findUnique({
                    where: { start_number: _pack.start_number },
                });
                return existing;
            }
            throw e;
        }
    };


    public static checkPack = async (_pack: Pack) => {

        const expected = generateFixed200(_pack.start_number);
        const expectedSet = new Set(expected);


        const cards = await prisma.steam_card.findMany({
            where: { pack_id: _pack.id },
            select: {
                id: true,
                barcode: true,
                activation_code: true
            }
        });


        const map = new Map<string, typeof cards>();
        for (const card of cards) {
            if (!map.has(card.barcode)) {
                map.set(card.barcode, []);
            }
            map.get(card.barcode)!.push(card);
        }


        const missing: string[] = [];
        for (const b of expected) {
            if (!map.has(b)) missing.push(b);
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
            } else {
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

    public static findPackById = async (_id: string) => {
        const pack = await prisma.pack.findUnique({
            where: {
                id: _id
            }
        });

        return pack;
    }
}