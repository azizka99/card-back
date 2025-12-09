function luhnCheckDigit(payload15: string): string {
    let sum = 0;
    for (let i = payload15.length - 1, posFromRight = 1; i >= 0; i--, posFromRight++) {
        let d = Number(payload15[i]);
        if (posFromRight % 2 === 1) {
            d *= 2;
            if (d > 9) d -= 9;
        }
        sum += d;
    }
    return String((10 - (sum % 10)) % 10);
}

// Generate exactly 200 barcodes from the 15-digit payload of `start`
export function generateFixed200(startCode: string): string[] {

    console.log('startCode',startCode);
    
    if (!/^\d{16}$/.test(startCode)) {
        throw new Error("`start` must be exactly 16 digits.");
    }

    const width = 15; // payload length
    let core = BigInt(startCode.slice(0, -1)); // work on the first 15 digits
    const results: string[] = [];

    for (let i = 0; i < 200; i++) {
        const coreStr = core.toString().padStart(width, "0");
        const check = luhnCheckDigit(coreStr);
        results.push(coreStr + check);
        core += 1n;

        // prevent overflow beyond 15 digits
        if (core > 999999999999999n && i < 199) {
            throw new Error("Reached the maximum 15-digit payload limit.");
        }
    }

    return results;
}