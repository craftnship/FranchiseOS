// Approximate centres of Indian cities, used to place a store or territory on the network map when
// its site and territory have no coordinates. Keys are lower-case city names.
export const CITY_COORDS: Record<string, [number, number]> = {
  "agra": [27.18, 78.01], "ahmedabad": [23.02, 72.57], "ajmer": [26.45, 74.64], "allahabad": [25.44, 81.85], "prayagraj": [25.44, 81.85],
  "amritsar": [31.63, 74.87], "aurangabad": [19.88, 75.34], "bengaluru": [12.97, 77.59], "bangalore": [12.97, 77.59], "belagavi": [15.85, 74.5],
  "bhopal": [23.26, 77.41], "bhubaneswar": [20.3, 85.82], "chandigarh": [30.73, 76.78], "chennai": [13.08, 80.27], "coimbatore": [11.02, 76.96],
  "cuttack": [20.46, 85.88], "dehradun": [30.32, 78.03], "delhi": [28.61, 77.21], "new delhi": [28.61, 77.21], "dhanbad": [23.8, 86.43],
  "erode": [11.34, 77.72], "faridabad": [28.41, 77.32], "gandhinagar": [23.22, 72.65], "ghaziabad": [28.67, 77.45], "goa": [15.5, 73.83],
  "panaji": [15.5, 73.83], "gurugram": [28.46, 77.03], "gurgaon": [28.46, 77.03], "guwahati": [26.14, 91.74], "gwalior": [26.22, 78.18],
  "hubballi": [15.36, 75.12], "hubli": [15.36, 75.12], "hyderabad": [17.39, 78.49], "indore": [22.72, 75.86], "jabalpur": [23.18, 79.99],
  "jaipur": [26.91, 75.79], "jalandhar": [31.33, 75.58], "jammu": [32.73, 74.86], "jamshedpur": [22.8, 86.2], "jodhpur": [26.24, 73.02],
  "kanpur": [26.45, 80.33], "kochi": [9.93, 76.27], "cochin": [9.93, 76.27], "kolhapur": [16.7, 74.24], "kolkata": [22.57, 88.36],
  "kozhikode": [11.26, 75.78], "calicut": [11.26, 75.78], "lucknow": [26.85, 80.95], "ludhiana": [30.9, 75.86], "madurai": [9.93, 78.12],
  "mangaluru": [12.91, 74.86], "mangalore": [12.91, 74.86], "meerut": [28.98, 77.71], "mumbai": [19.08, 72.88], "mysuru": [12.3, 76.64],
  "mysore": [12.3, 76.64], "nagpur": [21.15, 79.09], "nashik": [20.0, 73.79], "navi mumbai": [19.03, 73.03], "noida": [28.54, 77.39],
  "patna": [25.59, 85.14], "puducherry": [11.94, 79.81], "pondicherry": [11.94, 79.81], "pune": [18.52, 73.86], "raipur": [21.25, 81.63],
  "rajkot": [22.3, 70.8], "ranchi": [23.34, 85.31], "salem": [11.66, 78.15], "surat": [21.17, 72.83], "thane": [19.22, 72.98],
  "thiruvananthapuram": [8.52, 76.94], "trivandrum": [8.52, 76.94], "thrissur": [10.53, 76.21], "tiruchirappalli": [10.79, 78.7],
  "trichy": [10.79, 78.7], "tirunelveli": [8.71, 77.76], "tiruppur": [11.11, 77.34], "udaipur": [24.59, 73.71], "vadodara": [22.31, 73.18],
  "varanasi": [25.32, 82.97], "vellore": [12.92, 79.13], "vijayawada": [16.51, 80.65], "visakhapatnam": [17.69, 83.22], "vizag": [17.69, 83.22],
  "warangal": [17.97, 79.59], "hosur": [12.74, 77.83], "thanjavur": [10.79, 79.14], "nellore": [14.44, 79.99], "tirupati": [13.63, 79.42],
  "kannur": [11.87, 75.37], "kollam": [8.89, 76.61], "davanagere": [14.46, 75.92], "shivamogga": [13.93, 75.57], "guntur": [16.31, 80.44],
};

/** Coordinates for a city name, matching the first known city the name starts with ("Chennai T Nagar" → Chennai). */
export function cityCoords(name: unknown): [number, number] | null {
  const n = String(name ?? "").trim().toLowerCase();
  if (!n) return null;
  if (CITY_COORDS[n]) return CITY_COORDS[n];
  const hit = Object.keys(CITY_COORDS).filter((c) => n.startsWith(c + " ") || n.startsWith(c + ",")).sort((a, b) => b.length - a.length)[0];
  return hit ? CITY_COORDS[hit] : null;
}
