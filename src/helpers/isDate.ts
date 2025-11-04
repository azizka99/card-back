export function isValidDateString(str:string|Date) {
    const d = new Date(str);
    return !isNaN(d.getTime());
  }