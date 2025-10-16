

interface props {
    [key: string]: any
}

const isUndefined = (...vars: props[]) => {

    vars.forEach(element => {
        for (const [key, value] of Object.entries(element)) {
            if (value === undefined) {
                throw new Error(`${key} is undefined`);
            }
        }
    });
}

export default isUndefined