# Hotel search (FAI Browser task guide)

Read this with the main `fai-browser` skill when the user wants a stay found or compared in their live tab: a destination, check-in and check-out dates, guests and rooms, conditions (price cap, rating, area, free cancellation, breakfast). Booking.com is the site; Google Hotels (`https://www.google.com/travel/hotels?q=hotels%20in%20Paris`) only when the user names it.

## Phrasing
`instruction`: the page, then the fact to read: `Open <results URL> and read the properties listed.` Every condition goes in `answerQuestion`, inside the question sentence: `Which hotel under 200 € a night with a rating of 8 or more is cheapest, with its name, price for the stay and rating?` Ask the price as the site shows it (stay or per night). A three-part question returns the whole row (`exact: false`): give the user only the parts asked.

## The URL, not the pickers
The date and guest pickers ignore typed text (`fill_not_kept`). Never ask for typing. Name the results URL and list it in `allowedUrls`:
`https://www.booking.com/searchresults.html?ss=Paris&checkin=2027-03-01&checkout=2027-03-04&group_adults=2&group_children=0&no_rooms=1`
With site profiles on, FAI builds it itself from `hotels in <place> from <YYYY-MM-DD> to <YYYY-MM-DD>` plus `N adults`, `N children`, `N rooms`; unnamed guests default to 2 adults, 0 children, 1 room; over 30 nights builds nothing.

## Expectation
`{"urlIncludes": "/searchresults", "textIncludes": "properties found"}`. The site rewrites the URL on landing (it pins the place it chose), so never put the dates or the place in `urlIncludes`. A miss carries `verification.hint` with the page's headings: use it.

## Several stays or hotels: `steps`
One step per date range, each with its own URL, `expectation` and `answerQuestion`; `mode: "interactive"`; `allowedUrls` holds every URL. A few named hotels: one step per hotel, `Open the <name> page`, `{"urlIncludes": "/hotel/"}`. `verdict.answer.text` is one `step N: <value>` line per step (`verdict.answer.steps` by number): report them as the comparison.

## Mode and origins
`interactive` (sort and filter clicks included). `origins`: `["https://www.booking.com"]`, no consent origin. A cookie dialog is relayed below `full`, a sign-in nag below `testing`: tell the user, never log in. Reserving or paying is a purchase: FAI refuses it outside testing mode (`next.kind: stop`); tell the user to book it themselves.

## Traps
"Genius" prices need an account: read the price shown. Prices are for the whole stay, taxes noted beside them, unless asked per night. A sold-out row has no price; a "Sponsored" row is an advertisement, not the cheapest. Never open the map view.

## Stuck
`fill_not_kept` or a run ending on the start page: rerun with the URL above in `allowedUrls`. `expectation:text_missing`: use `verification.hint`. `more_offered`: the runtime clicks "Load more results" itself at `reversible` and up; if the answer is still unconfirmed, read `page.digest`. Then rung 2-4 of the main skill's F.
