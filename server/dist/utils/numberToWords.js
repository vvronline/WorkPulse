"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.numberToWords = numberToWords;
exports.amountToWords = amountToWords;
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
    "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function twoDigits(n) {
    if (n < 20)
        return ONES[n];
    return TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "");
}
function numberToWords(num) {
    if (num === 0)
        return "Zero";
    if (num < 0)
        return "Minus " + numberToWords(-num);
    const intPart = Math.floor(num);
    const parts = [];
    if (intPart >= 10000000) {
        parts.push(twoDigits(Math.floor(intPart / 10000000)) + " Crore");
    }
    const afterCrore = intPart % 10000000;
    if (afterCrore >= 100000) {
        parts.push(twoDigits(Math.floor(afterCrore / 100000)) + " Lakh");
    }
    const afterLakh = afterCrore % 100000;
    if (afterLakh >= 1000) {
        parts.push(twoDigits(Math.floor(afterLakh / 1000)) + " Thousand");
    }
    const afterThousand = afterLakh % 1000;
    if (afterThousand >= 100) {
        parts.push(ONES[Math.floor(afterThousand / 100)] + " Hundred");
    }
    const remainder = afterThousand % 100;
    if (remainder > 0) {
        parts.push(twoDigits(remainder));
    }
    const result = parts.join(" ") + " Only";
    return result;
}
function amountToWords(amount, currency = "INR") {
    const intPart = Math.floor(Math.abs(amount));
    const decPart = Math.round((Math.abs(amount) - intPart) * 100);
    const prefix = currency === "INR" ? "Rupees " : "";
    let text = prefix + numberToWords(intPart).replace(" Only", "");
    if (decPart > 0) {
        text += " and " + (currency === "INR" ? "Paise " : "Cents ") + numberToWords(decPart).replace(" Only", "");
    }
    text += " Only";
    return text;
}
//# sourceMappingURL=numberToWords.js.map