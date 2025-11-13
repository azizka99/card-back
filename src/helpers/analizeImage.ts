export async function analyzeImage(signedUrl: string) {
    const apiKey = 'AIzaSyAEyiqaY8-XnciYf8yEMvOW692bCsAA_b4';
    const endpoint = `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`;

    // Prepare Vision API request body
    const body = {
        requests: [
            {
                image: {
                    source: { imageUri: signedUrl }, // presigned S3 URL
                },
                features: [
                    {
                        type: "DOCUMENT_TEXT_DETECTION", // or "TEXT_DETECTION"
                        maxResults: 1,
                    },
                ],
            },
        ],
    };

    // Send request to Vision API
    const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Vision API error: ${response.status} ${errText}`);
    }

    const data = await response.json();

    // Extract recognized text
    const rawText =
        data?.responses?.[0]?.fullTextAnnotation?.text ||
        data?.responses?.[0]?.textAnnotations?.[0]?.description ||
        "";

    // Cleanup and replace  OCR misreads
    const cleanedText = cleanActivationCode(rawText)


    return { rawText, cleanedText };
}


function cleanActivationCode(input: string): string {
    if (!input) return "";

    let t = input.normalize("NFKD").toUpperCase();

    t = t
        .replace(/O/g, "0")
        .replace(/İ/g, "I")
        .replace(/[1l|]/gi, "I")
        .replace(/S/g, "5");

    t = t.replace(/[^A-Z0-9]/g, "").trim();

    // keep only first 15 characters
    if (t.length >= 15) {
        t = t.substring(0, 15);
        t = t.replace(/(.{5})(.{5})(.{5})/, "$1-$2-$3");
    }

    return t;
}


export function equalsIgnoringLToI(a: string, b: string): boolean {
    if (!a || !b) return false;
    if (a.length !== b.length) return false;

    for (let i = 0; i < a.length; i++) {
        const ca = a[i];
        const cb = b[i];

        if (ca === cb) continue;

        // only ignore the L → I mismatch
        const isLI =
            ca === 'L' && cb === 'I';

        if (!isLI) {
            return false; // any other mismatch → not equal
        }
    }
    return true; // all mismatches were allowed L→I
}