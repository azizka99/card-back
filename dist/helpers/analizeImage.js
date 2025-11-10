"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeImage = analyzeImage;
async function analyzeImage(signedUrl) {
    const apiKey = '/Users/azizka99/Documents/Arascom/flutter/aras_scan/lib/src/services/google_vision_service.dart';
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
    const rawText = data?.responses?.[0]?.fullTextAnnotation?.text ||
        data?.responses?.[0]?.textAnnotations?.[0]?.description ||
        "";
    // Cleanup and replace common OCR misreads
    const cleanedText = rawText
        .toUpperCase()
        .replaceAll(/o/g, "0")
        .replaceAll(/[1l]/g, "I")
        .replaceAll(/s/gi, "5")
        .replaceAll(" ", "")
        .trim();
    return { rawText, cleanedText };
}
