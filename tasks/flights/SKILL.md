# Flight search (FAI Browser task guide)

Read this with the main `fai-browser` skill when the user wants flights found or compared in their live tab: a route, one or more dates, a price or time condition. Everything the main skill says still holds; this adds what Google Flights taught live runs.

## Open
`fai_browser_open` with `origins: ["https://www.google.com", "https://consent.google.com"]`, `mode: "interactive"`, `task` the user's whole question with every condition (`Which flight departing before noon on 2027-01-12 is cheapest? Give the time, airline and price.`), and the results URL below in `allowedUrls` so it opens on approval.

## The URL, not the date picker
Google's Departure textbox opens a calendar and ignores typed dates: a fill comes back `fill_not_kept`. Never type dates. Open the results URL instead (`allowedUrls`, or `fai_browser_act` with `url`):
`https://www.google.com/travel/flights?q=One%20way%20flights%20from%20Marseille%20to%20London%20on%202027-01-12`
(`Round%20trip%20flights%20from%20A%20to%20B%20on%20D1%20returning%20on%20D2` for a return).

## Read and verify
Answer from `page.digest` when it holds the rows; `fai_browser_observe` with `focus` (for example "price departure") re-ranks, `digestChars` reads more. An act that lands on the results takes `expectation: {"urlIncludes": "/travel/flights", "textIncludes": "Top flights"}`. The results heading is "Top flights", not "Departing flights"; the `q` URL is often rewritten to `/travel/flights/search?tfs=...` once the page expands, so never put the date in `urlIncludes`. A miss carries `verification.hint` with the headings the page does have: correct the text from it.

## Several dates
One results URL per date, opened in turn with `url`; read each page and report the comparison yourself.

## Traps
The page keeps "Loading results" text next to its rows; that is not a load. The cookie wall lives on `consent.google.com`: reject it first. Booking a fare is a purchase: it runs only after the user's Approve once; if refused, tell the user to book it themselves.

## Stuck
`fill_not_kept` or the search page again: open the URL above. `expectation:text_missing`: use `verification.hint`. A short list with "View more flights": act on it, then observe again.
