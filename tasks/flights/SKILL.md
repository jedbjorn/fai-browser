# Flight search (FAI Browser task guide)

Read this with the main `fai-browser` skill when the user wants flights found or compared in their live tab: a route, one or more dates, a price or time condition. Everything the main skill says still holds; this adds what Google Flights taught live runs.

## Phrasing
`instruction`: name the page and the search, then the fact to read: `Open <search URL> and read the flights listed.` Put every condition in `answerQuestion`, never in `instruction`: `Which flight departing before noon on 2027-01-12 is cheapest? Give the time, airline and price.` A three-part question returns the whole row (`exact: false`); give the user only the parts asked.

## The URL, not the date picker
Google's Departure textbox opens a calendar and ignores typed dates: a fill comes back `fill_not_kept`. Never ask for typing. Name the results URL instead and list it in `allowedUrls`:
`https://www.google.com/travel/flights?q=One%20way%20flights%20from%20Marseille%20to%20London%20on%202027-01-12`
(`Round%20trip%20flights%20from%20A%20to%20B%20on%20D1%20returning%20on%20D2` for a return). With site profiles on, FAI builds the same URL itself from an instruction that says `flights from <place> to <place> on <YYYY-MM-DD>`.

## Expectation
`{"urlIncludes": "/travel/flights", "textIncludes": "Top flights"}`. The results heading is "Top flights", not "Departing flights"; the `q` URL is often rewritten to `/travel/flights/search?tfs=...` once the page expands, so never put the date in `urlIncludes`. A miss carries `verification.hint` with the headings the page does have: correct the text from it.

## Several dates: `steps`
One step per date, each with its own URL, `expectation` and `answerQuestion` (the same question with that date); `mode: "interactive"`; `allowedUrls` holds every URL. Five dates ran in 27 s. The call's `verdict.answer.text` is one `step N: <value>` line per step (`verdict.answer.steps` by number): report them as the comparison.

## Mode and origins
`interactive`. `origins`: `["https://www.google.com", "https://consent.google.com"]`. The page keeps "Loading results" text next to its rows; that is not a load.

## Stuck
`fill_not_kept` or a run that ends on the search page: rerun with the URL above in `allowedUrls`. `expectation:text_missing`: use `verification.hint`. `more_offered` on a short list: the runtime clicks "View more flights" itself at `reversible` and up; if the answer still is not confirmed, read `page.digest`. Then rung 2-4 of the main skill's F.
