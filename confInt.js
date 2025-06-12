// popup.js - Logic for the extension's popup UI and communication with content script

document.getElementById('checkConfidence').addEventListener('click', async () => {
    const resultContainer = document.getElementById('result-container');
    resultContainer.innerHTML = '<div class="loading-spinner"></div>'; // Show loading spinner while processing

    try {
        // Query for the currently active tab in the current window
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        // Validate if the current URL is a Google Maps place page
        if (!tab.url || !tab.url.startsWith('https://www.google.com/maps/')) {
            resultContainer.innerHTML = '<p class="error-message">Please open this extension on a specific Google Maps place page (e.g., a restaurant, store, or landmark).</p>';
            return;
        }

        // Execute a content script on the current tab to extract relevant data
        const injectionResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            function: extractGoogleMapsPlaceData,
        });

        // The result from the content script is in injectionResults[0].result
        const extractedData = injectionResults[0].result;

        if (extractedData && extractedData.placeName && extractedData.reviewsCount !== null) {
            const { placeName, reviewsCount, category } = extractedData;

            // Define category-specific weights for confidence calculation.
            // 'maxReviews' is a normalization factor. 'weight' is the category's influence.
            // 'baseUncertaintyFactor' influences the standard error (lower for more reliable categories).
            const categoryConfigs = {
                'Restaurant': { maxReviews: 5000, weight: 0.85, baseUncertaintyFactor: 0.15 },
                'Cafe': { maxReviews: 3000, weight: 0.80, baseUncertaintyFactor: 0.20 },
                'Store': { maxReviews: 2000, weight: 0.70, baseUncertaintyFactor: 0.30 },
                'Park': { maxReviews: 500, weight: 0.40, baseUncertaintyFactor: 0.60 }, // Reviews might be less indicative for parks
                'Hotel': { maxReviews: 10000, weight: 0.90, baseUncertaintyFactor: 0.10 },
                'Museum': { maxReviews: 1500, weight: 0.65, baseUncertaintyFactor: 0.35 },
                'Bank': { maxReviews: 300, weight: 0.30, baseUncertaintyFactor: 0.70 }, // Reviews less relevant for banks
                'Hospital': { maxReviews: 2000, weight: 0.50, baseUncertaintyFactor: 0.50 },
                'School': { maxReviews: 1000, weight: 0.45, baseUncertaintyFactor: 0.55 },
                'Generic': { maxReviews: 1000, weight: 0.55, baseUncertaintyFactor: 0.45 } // Fallback for unknown categories
            };

            // Determine the category configuration based on extracted category text
            let selectedCategoryConfig = categoryConfigs['Generic'];
            let matchedCategoryName = 'Generic';

            // Simple keyword matching for categories
            const lowerCategory = category.toLowerCase();
            for (const key in categoryConfigs) {
                if (lowerCategory.includes(key.toLowerCase()) || placeName.toLowerCase().includes(key.toLowerCase())) {
                    selectedCategoryConfig = categoryConfigs[key];
                    matchedCategoryName = key;
                    break;
                }
            }

            // Calculate the main confidence score (mu)
            // Normalized reviews based on category's maxReviews
            const normalizedReviews = Math.min(reviewsCount, selectedCategoryConfig.maxReviews);
            const mu_confidence_score = (normalizedReviews / selectedCategoryConfig.maxReviews) * selectedCategoryConfig.weight * 100;

            // Calculate the standard error (se) for the confidence score
            // Heuristic: SE is inversely proportional to sqrt(reviewsCount),
            // and proportional to a base uncertainty factor specific to the category.
            // Adding 1 to reviewsCount to avoid division by zero for places with 0 reviews.
            const effectiveSampleSize = Math.sqrt(reviewsCount + 1);
            const baseErrorMagnitude = 20; // A base value to scale the SE, can be tuned
            const se = (baseErrorMagnitude * selectedCategoryConfig.baseUncertaintyFactor) / effectiveSampleSize;

            // Define the Z-score for the desired confidence level (k)
            // For 95% confidence level, k ≈ 1.96
            const k_z_score = 1.96; // Corresponds to 95% confidence for a normal distribution

            // Calculate the confidence interval
            const lowerBound = Math.max(0, mu_confidence_score - se * k_z_score);
            const upperBound = Math.min(100, mu_confidence_score + se * k_z_score);

            // Display results
            resultContainer.innerHTML = `
                <p class="info-message"><strong>Place:</strong> ${placeName}</p>
                <p class="info-message"><strong>Category:</strong> ${category} (${matchedCategoryName} match)</p>
                <p class="info-message"><strong>Total Reviews:</strong> ${reviewsCount.toLocaleString()}</p>
                <hr style="border: 0; height: 1px; background: #ddd; margin: 10px 0;">
                <p style="font-size: 1.1rem;"><strong>Estimated Confidence:</strong> <span style="font-size: 1.3rem; font-weight: bold; color: ${getConfidenceColor(mu_confidence_score)};">${mu_confidence_score.toFixed(2)}%</span></p>
                <p style="font-size: 0.95rem;"><strong>95% Confidence Interval:</strong> [${lowerBound.toFixed(2)}% - ${upperBound.toFixed(2)}%]</p>
                <p style="font-size: 0.8rem; color: #666; margin-top: 5px;">(Based on reviews count and category weighting)</p>
            `;

        } else if (extractedData && !extractedData.placeName) {
            resultContainer.innerHTML = '<p class="error-message">Could not identify a specific place name on this Google Maps page. Please ensure it\'s a detailed place page.</p>';
        } else {
            resultContainer.innerHTML = '<p class="error-message">Could not extract sufficient data (place name or review count) from the current Google Maps page. Navigate to a place with reviews.</p>';
        }

    } catch (error) {
        console.error('Error in popup.js:', error);
        resultContainer.innerHTML = '<p class="error-message">An unexpected error occurred. Please try again. Check console for details.</p>';
    }
});

/**
 * Determines the color for the confidence score.
 * @param {number} confidence - The calculated confidence percentage.
 * @returns {string} - A hex color code.
 */
function getConfidenceColor(confidence) {
    if (confidence >= 80) return '#38a169'; // Green (high confidence)
    if (confidence >= 50) return '#d69e2e'; // Orange (medium confidence)
    return '#e53e3e'; // Red (low confidence)
}

/**
 * This function is injected as a content script into the Google Maps page.
 * It attempts to extract the place name, total review count, and category.
 * IMPORTANT: Google Maps' DOM structure changes frequently. These selectors
 * might need to be updated in the future to remain accurate.
 * @returns {object} - An object containing extracted placeName, reviewsCount, and category.
 */
function extractGoogleMapsPlaceData() {
    let placeName = null;
    let reviewsCount = null;
    let category = 'Generic'; // Default category

    // --- Attempt to extract Place Name ---
    // Selector for the main place title (h1)
    const titleElement = document.querySelector('h1.fontHeadlineLarge');
    if (titleElement) {
        placeName = titleElement.textContent.trim();
    } else {
        // Fallback for address if h1 is not present (e.g., direct address search)
        const addressElement = document.querySelector('div[data-tooltip="Copy address"]');
        if (addressElement) {
            placeName = addressElement.textContent.trim();
        } else {
            // More robust check for current active place name/address from URL or other prominent elements
            const urlParams = new URLSearchParams(window.location.search);
            const query = urlParams.get('q');
            if (query) {
                placeName = query.split(',')[0].trim(); // Take first part of query as name
            } else {
                // Last resort: look for a prominent, non-empty text that might be a name
                const prominentTextElements = document.querySelectorAll('h1, h2, div[aria-label][role="region"] > div > div > div > span:not([aria-label])');
                for (let i = 0; i < prominentTextElements.length; i++) {
                    const text = prominentTextElements[i].textContent.trim();
                    if (text.length > 5 && prominentTextElements[i].offsetWidth > 0 && prominentTextElements[i].offsetHeight > 0 && !text.includes('reviews')) {
                        placeName = text;
                        break;
                    }
                }
            }
        }
    }


    // --- Attempt to extract Reviews Count ---
    // Selectors for review count, often within a span with aria-label or a button
    // It's common for Google Maps to use classes like 'DkEaL' or specific data attributes.
    const reviewElements = document.querySelectorAll(
        'span.DkEaL[aria-label][role="img"], ' + // Primary review count element
        'button[data-item-id="reviews"] span.fontBodySmall, ' + // Review button count
        'div.section-star-display span:not([aria-label*="star rating"])' // Another potential span near star rating
    );

    for (const el of reviewElements) {
        let text = el.textContent.trim();
        let match;

        // Try extracting from aria-label first, as it's often more structured
        if (el.hasAttribute('aria-label')) {
            match = el.getAttribute('aria-label').match(/\(([\d,]+) reviews\)/);
        }

        // If not found in aria-label, try to parse from text content
        if (!match && text) {
            match = text.match(/([\d,]+)/);
        }

        if (match && match[1]) {
            reviewsCount = parseInt(match[1].replace(/,/g, ''), 10);
            break; // Found reviews, stop searching
        }
    }
    // If no reviews count found, default to 0 for calculation
    if (reviewsCount === null) {
        reviewsCount = 0;
    }

    // --- Attempt to extract Category ---
    // Categories are often found in a span/div near the title or in the details panel.
    // This is highly variable and often requires inspecting the specific page's DOM.
    const categoryElements = document.querySelectorAll(
        'span.DkEaL:not([role="img"]), ' + // Category often uses same class as reviews but without img role
        'button[jsaction*="category"] > span.fontBodySmall, ' + // Category link button
        'div.section-info-text, ' + // General info text block
        'span[aria-label*="Category"]' // Accessibility label for category
    );

    for (const el of categoryElements) {
        const text = el.textContent.trim();
        // Heuristic: category text is usually relatively short and descriptive and not a number
        if (text.length > 0 && text.length < 50 && isNaN(parseInt(text.replace(/,/g, ''), 10)) && !text.includes('reviews') && !text.includes('directions')) {
            category = text;
            break; // Found a plausible category, stop searching
        }
    }

    return {
        placeName: placeName,
        reviewsCount: reviewsCount,
        category: category
    };
}
