import "express-session";

declare module "express-session" {
  interface SessionData {
    isAuthed?: boolean;   // add whatever else you need here
    // userId?: string;
  }
}