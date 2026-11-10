# Hotel search (FAI Browser task guide)

Read this with the main `fai-browser` skill when the user wants a stay found or compared in their live tab: a destination, check-in and check-out dates, guests and rooms, conditions (price cap, rating, area, free cancellation, breakfast). Booking.com is the site; Google Hotels (`https://www.google.com/travel/hotels?q=hotels%20in%20Paris`) only when the user names it.

## Open
`fai_browser_open` with `origins: ["https://www.booking.com"]` (no consent origin), `mode: "interactive"` (sort and filter clicks included), `task` the user's whole question with every condition, and the results URL in `allowedUrls` so it opens on approval.

## The URL, not the pickers
The date and guest pickers ignore typed text (`fill_not_kept`). Never type dates. Build the results URL and open it (`allowedUrls`, or `fai_browser_act` with `url`):
`https://www.booking.com/searchresults.html?ss=Paris&checkin=2027-03-01&checkout=2027-03-04&group_adults=2&group_children=0&no_rooms=1`
Unnamed guests: 2 adults, 0 children, 1 room.

## Read and verify
Answer from `page.digest` when it holds the rows; `fai_browser_observe` with `focus` (for example "price rating") re-ranks a long list, `digestChars` reads more. An act that lands on the results takes `expectation: {"urlIncludes": "/searchresults", "textIncludes": "properties found"}`. The site rewrites the URL on landing, so never put the dates or the place in `urlIncludes`. A miss carries `verification.hint` with the page's headings: use it.

## Several stays
One results URL per date range, opened in turn with `url`; read each page and compare yourself. A few named hotels: open each hotel page, `{"urlIncludes": "/hotel/"}`.

## Traps
"Genius" prices need an account: read the price shown. Prices are for the whole stay, taxes noted beside them, unless asked per night. A sold-out row has no price; a "Sponsored" row is an advertisement, not the cheapest. Never open the map view. A cookie dialog is relayed below `full`, a sign-in nag below `testing`: tell the user, never log in. Reserving or paying is a purchase: it runs only after the user's Approve once; if refused (`next.kind: stop`), tell the user to book it themselves.

## Stuck
`fill_not_kept` or the start page again: open the URL above. `expectation:text_missing`: use `verification.hint`. A "Load more results" action loads more rows; then observe again.
