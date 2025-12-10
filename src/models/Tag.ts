import prisma from "../constants/dbConnection";
import isUndefined from "../helpers/isUndefined";
import { validate as isUuid } from "uuid";
import { isValidDateString } from "../helpers/isDate";

export class Tag {
    private id: string;
    private name: string;
    private created_at: Date;
    private userId?: string;

    constructor(_id: string, _name: string, _createdAt: Date, _userId?: string) {
        isUndefined(
            { id: _id },
            { name: _name },
            { createdAt: _createdAt }
        );

        if (!isUuid) {
            throw new Error("Invalid UUID format");
        }

        if (_name.length === 0 || _name.length > 100) {
            throw new Error("Name's length should be more than 0 and less than 100");
        }

        if (!isValidDateString(_createdAt)) {
            throw new Error("This is not a Date!");
        }

        this.id = _id;
        this.name = _name;
        this.created_at = _createdAt;
        if (_userId) {
            this.userId = _userId;
        }

    }

    public getTag = () => {
        return {
            id: this.id,
            name: this.name,
            created_at: this.created_at
        }
    }


    public static createTag = async (tag: Tag) => {
        const createdTag = await prisma.tag.create({
            data: {
                id: tag.id,
                name: tag.name,
                created_at: tag.created_at,
                userId: tag.userId
            }
        });

        return createdTag;
    }

    public static findTagById = async (id: string) => {
        const tag = await prisma.tag.findFirstOrThrow({
            where: {
                id
            }
        });

        return tag;
    }

    public static findTagByUserId = async (userid: string) => {
        const tags = await prisma.tag.findMany({
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
        })

        return tags
    }

    public static approveByUserById = async (_tag: Tag) => {
        const tag = await prisma.tag.update({
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


    }

}