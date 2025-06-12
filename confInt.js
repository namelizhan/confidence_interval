// popup.js - Logic for the extension's popup UI and communication with content script

document.getElementById('checkConfidence').addEventListener('click', async () => {
    const resultContainer = document.getElementById('result-container');
    resultContainer.innerHTML = '<div class="loading-spinner"></div>'; // Show loading spinner while processing

    try {
        // Query for the currently active tab in the current window
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        // Validate if the current URL is a Google Maps reviews page or a place page
        if (!tab.url || !tab.url.startsWith('https://www.google.com/maps/')) {
            resultContainer.innerHTML = '<p class="error-message">Please open this extension on a Google Maps place page or a specific reviews tab.</p>';
            return;
        }

        // Execute a content script on the current tab to extract relevant data
        const injectionResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            function: extractGoogleMapsReviewData,
        });

        const extractedData = injectionResults[0].result;

        if (extractedData && extractedData.placeName && extractedData.reviewsCount !== null) {
            const { placeName, reviewsCount, category, starCounts } = extractedData;

            // Check if we have enough data for statistical analysis
            const totalReviewsCount = sumArray(starCounts);
            if (totalReviewsCount === 0 || !starCounts || starCounts.length !== 5) {
                resultContainer.innerHTML = `
                    <p class="info-message"><strong>Place:</strong> ${placeName}</p>
                    <p class="info-message"><strong>Category:</strong> ${category}</p>
                    <p class="info-message"><strong>Total Reviews:</strong> ${reviewsCount.toLocaleString()}</p>
                    <hr style="border: 0; height: 1px; background: #ddd; margin: 10px 0;">
                    <p class="error-message">Not enough detailed review data (star distribution) found for confidence calculation.</p>
                    <p style="font-size: 0.85rem; color: #4a5568;">(Navigate to a place with visible review statistics for full analysis)</p>
                `;
                return;
            }

            // --- Implementing your Python logic in JavaScript ---
            const { mu: meanStarRating, se: seStarRating } = getMeanAndSE(starCounts);

            // Calculate the 95% confidence interval for the mean star rating
            // Using prob = 0.95, so 1 - (1 - 0.95) / 2 = 1 - 0.05 / 2 = 1 - 0.025 = 0.975
            // The Z-score (k) for 97.5th percentile (for 95% CI) is approx 1.96
            const k_z_score = 1.96; // For 95% confidence level

            const confidenceIntervalStars = get_confidence_int(meanStarRating, seStarRating, k_z_score);

            // --- Mapping to 0-100% Confidence Level for Display ---
            // Scale the mean star rating from 1-5 to 0-100%
            // 1 star = 0% confidence, 5 stars = 100% confidence
            const estimatedConfidencePercent = ((meanStarRating - 1) / 4) * 100;

            // Scale the confidence interval bounds from 1-5 stars to 0-100%
            const lowerBoundPercent = ((confidenceIntervalStars[0] - 1) / 4) * 100;
            const upperBoundPercent = ((confidenceIntervalStars[1] - 1) / 4) * 100;

            // Ensure bounds are within 0-100%
            const displayLowerBound = Math.max(0, lowerBoundPercent);
            const displayUpperBound = Math.min(100, upperBoundPercent);


            // Display results
            resultContainer.innerHTML = `
                <p class="info-message"><strong>Place:</strong> ${placeName}</p>
                <p class="info-message"><strong>Category:</strong> ${category}</p>
                <p class="info-message"><strong>Total Reviews:</strong> ${reviewsCount.toLocaleString()}</p>
                <p class="info-message"><strong>Mean Star Rating:</strong> ${meanStarRating.toFixed(2)}</p>
                <p class="info-message"><strong>95% CI for Mean Stars:</strong> [${confidenceIntervalStars[0].toFixed(2)} - ${confidenceIntervalStars[1].toFixed(2)}]</p>
                <hr style="border: 0; height: 1px; background: #ddd; margin: 10px 0;">
                <p style="font-size: 1.1rem;"><strong>Estimated Confidence:</strong> <span style="font-size: 1.3rem; font-weight: bold; color: ${getConfidenceColor(estimatedConfidencePercent)};">${estimatedConfidencePercent.toFixed(2)}%</span></p>
                <p style="font-size: 0.95rem;"><strong>95% Confidence Interval (Scaled):</strong> [${displayLowerBound.toFixed(2)}% - ${displayUpperBound.toFixed(2)}%]</p>
                <p style="font-size: 0.8rem; color: #666; margin-top: 5px;">(Confidence derived from mean star rating and its interval)</p>
            `;

        } else if (extractedData && !extractedData.placeName) {
            resultContainer.innerHTML = '<p class="error-message">Could not identify a specific place name on this Google Maps page. Please ensure it\'s a detailed place page.</p>';
        } else {
            resultContainer.innerHTML = '<p class="error-message">Could not extract sufficient data (place name, review count, or star percentages) from the current Google Maps page. Navigate to a Google Maps place page with visible review statistics.</p>';
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

// --- Your Python statistical functions translated to JavaScript ---

/**
 * Helper to convert text like "1,234 reviews" to a number.
 * @param {string} text - The input text string.
 * @returns {number} - The parsed number.
 */
function text_to_num(text) {
    if (!text) return 0;
    const match = text.match(/([\d,]+)/);
    if (match && match[1]) {
        return parseInt(match[1].replace(/,/g, ''), 10);
    }
    return 0;
}

/**
 * Helper to parse 'width: X%;' from style attribute to a float percentage.
 * @param {string} styleText - The style attribute string.
 * @returns {number} - The percentage as a float (e.g., 73 for "width: 73%;").
 */
function percents_to_real_percents(styleText) {
    if (!styleText) return 0;
    const match = styleText.match(/width:\s*([\d.]+)%/);
    if (match && match[1]) {
        return parseFloat(match[1]);
    }
    return 0;
}

/**
 * Calculates the mean star rating given an array of review counts per star.
 * @param {number[]} revs - Array of review counts for [5-star, 4-star, 3-star, 2-star, 1-star].
 * @returns {number} - The mean star rating.
 */
function mean_stars(revs) {
    if (revs.length !== 5) return 0;
    const totalReviews = sumArray(revs);
    if (totalReviews === 0) return 0;

    let weightedSum = 0;
    for (let i = 0; i < 5; i++) {
        weightedSum += revs[i] * (5 - i); // revs[0] is 5-star, revs[1] is 4-star, etc.
    }
    return weightedSum / totalReviews;
}

/**
 * Calculates the standard deviation of star ratings.
 * @param {number[]} revs - Array of review counts for [5-star, 4-star, 3-star, 2-star, 1-star].
 * @param {number} mu - The mean star rating.
 * @returns {number} - The standard deviation.
 */
function standard_dev_stars(revs, mu) {
    if (revs.length !== 5) return 0;
    const totalReviews = sumArray(revs);
    if (totalReviews <= 1) return 0; // Standard deviation requires at least 2 data points

    let sumSquaredDifferences = 0;
    for (let i = 0; i < 5; i++) {
        const starValue = (5 - i); // Corresponds to 5, 4, 3, 2, 1 stars
        sumSquaredDifferences += revs[i] * Math.pow(starValue - mu, 2);
    }
    return Math.sqrt(sumSquaredDifferences / (totalReviews - 1));
}

/**
 * Helper to sum elements in an array.
 * @param {number[]} arr - The array to sum.
 * @returns {number} - The sum of array elements.
 */
function sumArray(arr) {
    return arr.reduce((sum, current) => sum + current, 0);
}

/**
 * Translates your get_mean_and_se Python function to JavaScript.
 * Gets the mean star rating and the standard error of the mean.
 * @param {number[]} rev_nums - Array of review counts for [5-star, 4-star, 3-star, 2-star, 1-star].
 * @returns {{mu: number, se: number}} - Object with mean star rating and its standard error.
 */
function getMeanAndSE(rev_nums) {
    const mu = mean_stars(rev_nums);
    const standard_dev = standard_dev_stars(rev_nums, mu);
    const totalReviews = sumArray(rev_nums);
    // Standard error is standard_dev / sqrt(n). Handle n=0 case.
    const se = totalReviews > 0 ? standard_dev / Math.sqrt(totalReviews) : 0;
    return { mu, se };
}

/**
 * Translates your get_confidence_int Python function to JavaScript.
 * Calculates the confidence interval for the mean.
 * @param {number} mu - The mean value (mean star rating).
 * @param {number} se - The standard error of the mean.
 * @param {number} k - The Z-score (e.g., 1.96 for 95% confidence).
 * @returns {number[]} - An array [lower_bound, upper_bound] of the confidence interval.
 */
function get_confidence_int(mu, se, k) {
    const lowerBound = mu - se * k;
    const upperBound = mu + se * k;
    return [lowerBound, upperBound];
}


/**
 * This function is injected as a content script into the Google Maps page.
 * It extracts the place name, total review count, category, and crucially,
 * the number of reviews for each star rating (5-star down to 1-star).
 * IMPORTANT: Google Maps' DOM structure changes frequently. These selectors
 * might need to be updated in the future to remain accurate.
 * @returns {object} - An object containing extracted data.
 */
function extractGoogleMapsReviewData() {
    let placeName = null;
    let reviewsCount = null;
    let category = 'Generic';
    let starPercentages = []; // Array to store percentages for 5, 4, 3, 2, 1 stars
    let starCounts = []; // Array to store calculated counts for 5, 4, 3, 2, 1 stars

    // --- Attempt to extract Place Name ---
    const titleElement = document.querySelector('h1.fontHeadlineLarge');
    if (titleElement) {
        placeName = titleElement.textContent.trim();
    } else {
        const addressElement = document.querySelector('div[data-tooltip="Copy address"]');
        if (addressElement) {
            placeName = addressElement.textContent.trim();
        } else {
            const urlParams = new URLSearchParams(window.location.search);
            const query = urlParams.get('q');
            if (query) {
                placeName = query.split(',')[0].trim();
            } else {
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

    // --- Attempt to extract Total Reviews Count and Mean Rating ---
    // Total reviews count (e.g., "1,687 reviews")
    // This selector targets a div with fontBodySmall that also contains a span with aria-label for star rating
    const reviewsNumElement = document.querySelector('div.fontBodySmall:has(span[aria-label*="star rating"])');
    if (reviewsNumElement) {
        reviewsCount = text_to_num(reviewsNumElement.textContent);
    } else {
        // Fallback for total reviews if the above selector doesn't work (e.g., reviews button)
        const reviewsButton = document.querySelector('button[data-item-id="reviews"] span.fontBodySmall');
        if (reviewsButton) {
            reviewsCount = text_to_num(reviewsButton.textContent);
        }
    }
    // Default to 0 if not found
    if (reviewsCount === null) {
        reviewsCount = 0;
    }


    // --- Attempt to extract Star Percentages (from the progress bars) ---
    // Based on your screenshot, the bars are div with class 'oxIpGd'
    const starBarElements = document.querySelectorAll('div.oxIpGd');
    if (starBarElements.length >= 5) { // Expecting 5 bars (5-star down to 1-star)
        for (let i = 0; i < 5; i++) {
            const style = starBarElements[i].getAttribute('style');
            starPercentages.push(percents_to_real_percents(style));
        }
    }

    // --- Calculate estimated count for each star (revs in your Python code) ---
    if (reviewsCount > 0 && starPercentages.length === 5) {
        const totalPercentageSum = sumArray(starPercentages);
        if (totalPercentageSum > 0) { // Avoid division by zero
            for (let i = 0; i < 5; i++) {
                starCounts.push(Math.round(reviewsCount * (starPercentages[i] / totalPercentageSum)));
            }
        } else {
            starCounts = [0, 0, 0, 0, 0]; // All percentages are zero, so all counts are zero
        }
    } else {
        starCounts = [0, 0, 0, 0, 0]; // Default to zero counts if data is missing
    }


    // --- Attempt to extract Category ---
    const categoryElements = document.querySelectorAll(
        'span.DkEaL:not([role="img"]), ' + // Common class for category text
        'button[jsaction*="category"] > span.fontBodySmall, ' + // Category link button
        'div.section-info-text, ' + // General info text block
        'span[aria-label*="Category"]' // Accessibility label for category
    );

    for (const el of categoryElements) {
        const text = el.textContent.trim();
        // Heuristic: category text is usually relatively short and descriptive and not a number
        if (text.length > 0 && text.length < 50 && isNaN(parseInt(text.replace(/,/g, ''), 10)) && !text.includes('reviews') && !text.includes('directions')) {
            category = text;
            break;
        }
    }

    return {
        placeName: placeName,
        reviewsCount: reviewsCount,
        category: category,
        starCounts: starCounts // e.g., [5-star count, 4-star count, ..., 1-star count]
    };
}
