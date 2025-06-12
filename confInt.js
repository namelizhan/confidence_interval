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
            function: extractGoogleMapsReviewData, // This function needs to correctly extract data
        });

        const extractedData = injectionResults[0].result;

        if (extractedData && extractedData.placeName && extractedData.reviewsCount !== null) {
            const { placeName, reviewsCount, category, starCounts } = extractedData;

            // Check if we have enough data for statistical analysis
            const totalReviewsCount = sumArray(starCounts);
            if (totalReviewsCount === 0 || !starCounts || starCounts.length !== 5) {
                resultContainer.innerHTML = `
                    <p class="error-message">Not enough detailed review data found for confidence calculation.</p>
                    <p style="font-size: 0.85rem; color: #4a5568;">(Navigate to a place with visible review statistics for full analysis)</p>
                `;
                return;
            }

            // --- Implementing your Python logic in JavaScript ---
            const { mu: meanStarRating, se: seStarRating } = getMeanAndSE(starCounts);

            // Calculate the 95% confidence interval for the mean star rating
            const k_z_score = 1.96; // For 95% confidence level

            const confidenceIntervalStars = get_confidence_int(meanStarRating, seStarRating, k_z_score);

            // --- Mapping to 0-100% Confidence Level for Display ---
            // Scale the mean star rating from 1-5 to 0-100%
            const estimatedConfidencePercent = ((meanStarRating - 1) / 4) * 100;

            // Scale the confidence interval bounds from 1-5 stars to 0-100%
            const lowerBoundPercent = ((confidenceIntervalStars[0] - 1) / 4) * 100;
            const upperBoundPercent = ((confidenceIntervalStars[1] - 1) / 4) * 100;

            // Ensure bounds are within 0-100%
            const displayLowerBound = Math.max(0, lowerBoundPercent);
            const displayUpperBound = Math.min(100, upperBoundPercent);


            // --- Display only Confidence Level and Interval ---
            resultContainer.innerHTML = `
                <p style="font-size: 1.1rem;"><strong>Estimated Confidence:</strong> <span style="font-size: 1.3rem; font-weight: bold; color: ${getConfidenceColor(estimatedConfidencePercent)};">${estimatedConfidencePercent.toFixed(2)}%</span></p>
                <p style="font-size: 0.95rem;"><strong>95% Confidence Interval:</strong> [${displayLowerBound.toFixed(2)}% - ${displayUpperBound.toFixed(2)}%]</p>
                <p style="font-size: 0.8rem; color: #666; margin-top: 5px;">(Derived from review distribution)</p>
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
    const se = totalReviews > 0 ? standard_dev / Math.sqrt(totalReviews) : 0; // Handle n=0 case gracefully
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
 * It attempts to extract the place name, total review count, category, and crucially,
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
    // Selector 1: Main H1 title
    const titleElement = document.querySelector('h1.fontHeadlineLarge');
    if (titleElement) {
        placeName = titleElement.textContent.trim();
    } else {
        // Selector 2: Address line (often visible if H1 is not found for specific place)
        const addressElement = document.querySelector('div[data-tooltip="Copy address"]');
        if (addressElement) {
            placeName = addressElement.textContent.trim();
        } else {
            // Selector 3: Extract from URL query parameter 'q' as a fallback
            const urlParams = new URLSearchParams(window.location.search);
            const query = urlParams.get('q');
            if (query) {
                placeName = query.split(',')[0].trim();
            } else {
                // Selector 4: General prominent text elements that might be the name
                const prominentTextElements = document.querySelectorAll('h1, h2, div[aria-label][role="region"] > div > div > div > span:not([aria-label]), div[role="main"] h1');
                for (let i = 0; i < prominentTextElements.length; i++) {
                    const text = prominentTextElements[i].textContent.trim();
                    // Basic heuristic to avoid generic text or review counts
                    if (text.length > 5 && prominentTextElements[i].offsetWidth > 0 && prominentTextElements[i].offsetHeight > 0 && !text.includes('reviews') && !/\d+\.\d+/.test(text)) {
                        placeName = text;
                        break;
                    }
                }
            }
        }
    }

    // --- Attempt to extract Total Reviews Count ---
    // Selector 1: Element containing total reviews count like "1,687 reviews"
    // This targets a span within a specific structure often seen on review pages
    const reviewsCountSpan = document.querySelector('span[aria-label*="star rating"] + span.fontBodySmall, button[data-item-id="reviews"] span.fontBodySmall, div[aria-label*="reviews"] > div.fontBodySmall');

    if (reviewsCountSpan) {
        reviewsCount = text_to_num(reviewsCountSpan.textContent);
    } else {
        // Fallback: search for any strong indicator of review count, sometimes on a button
        const reviewsButton = document.querySelector('button[data-item-id="reviews"]');
        if (reviewsButton && reviewsButton.textContent.includes('reviews')) {
            reviewsCount = text_to_num(reviewsButton.textContent);
        }
    }
    if (reviewsCount === null) {
        reviewsCount = 0; // Default to 0 if no reviews count found
    }

    // --- Attempt to extract Star Percentages (from the progress bars) ---
    // These are the elements like <div class="oxIpGd" style="width: 73%;">
    // Often nested within a table-like structure of review breakdowns.
    const starBarElements = document.querySelectorAll('div.BHXU6e div.OXlg7c div.oxIpGd'); // More specific path

    // Fallback if the above doesn't work, try a more generic path
    if (starBarElements.length < 5) {
        starBarElements = document.querySelectorAll('div.oxIpGd'); // The original generic one
    }

    if (starBarElements.length >= 5) { // Expecting 5 bars (5-star down to 1-star)
        for (let i = 0; i < 5; i++) {
            const style = starBarElements[i].getAttribute('style');
            starPercentages.push(percents_to_real_percents(style));
        }
    } else {
        // Log a warning if star bars aren't found as expected
        console.warn("Could not find 5 star percentage bars. Found:", starBarElements.length);
        starPercentages = [0, 0, 0, 0, 0]; // Default to 0 if not found
    }

    // --- Calculate estimated count for each star ---
    if (reviewsCount > 0 && starPercentages.length === 5) {
        const totalPercentageSum = sumArray(starPercentages);
        if (totalPercentageSum > 0) {
            for (let i = 0; i < 5; i++) {
                // Adjust to ensure percentages add up to 100 before distribution
                const normalizedPercentage = starPercentages[i] / totalPercentageSum;
                starCounts.push(Math.round(reviewsCount * normalizedPercentage));
            }
        } else {
            starCounts = [0, 0, 0, 0, 0];
        }
    } else {
        starCounts = [0, 0, 0, 0, 0];
    }


    // --- Attempt to extract Category ---
    // Selector 1: Common class for category text
    const categoryElements = document.querySelectorAll(
        'span.DkEaL:not([role="img"]), ' +
        'button[jsaction*="category"] > span.fontBodySmall, ' +
        'div.section-info-text, ' +
        'span[aria-label*="Category"], ' +
        'button[jsaction*="action.category"] > span:last-child' // Another common pattern for category button
    );

    for (const el of categoryElements) {
        const text = el.textContent.trim();
        // Heuristic: category text is usually relatively short and descriptive and not a number or review-related
        if (text.length > 0 && text.length < 50 && isNaN(parseInt(text.replace(/,/g, ''), 10)) && !text.includes('reviews') && !text.includes('directions') && !text.includes('rating')) {
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