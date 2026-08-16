# Failure taxonomy — Errata arm, run `rerunD-g5`

150 questions (the seeded comparison-150). The arm is deterministic across the three seeds — 0 of 150 questions changed answer or verdict between seeds 11/22/33 — so the taxonomy is built once per question and multiplies by 3 for the 450-row totals.

## Counts

| Bucket | n | % of 150 | Meaning |
|---|---:|---:|---|
| `A1_no_anchor` | 0 | 0.0 | abstained · no entity anchor resolved (lexicon matched no question token) |
| `A2_no_attribute_fit` | 0 | 0.0 | abstained · anchors resolved but no claim scored above zero |
| `A3_material_lacked_it` | 27 | 18.0 | abstained · synthesis saw material that did not contain the answer |
| `A4_material_had_it` | 4 | 2.7 | abstained · the answering claim WAS in the material (over-refusal) |
| `A5_below_tau` | 0 | 0.0 | abstained · deterministic evidence score below tau |
| `B1_wrong_claim_picked` | 7 | 4.7 | answered wrong · a gold-supporting claim was in the material |
| `B2_extraction_gap` | 15 | 10.0 | answered wrong · no claim in the history supports the gold answer |
| `B3_judge_rejected` | 3 | 2.0 | answered wrong · answer text contains the gold answer (judge call) |
| `C_false_answer` | 2 | 1.3 | answered a gold-abstention question |
| `ok_answered` | 64 | 42.7 | answered and judged CORRECT |
| `ok_abstained` | 28 | 18.7 | abstained on a gold-abstention question |

Abstained-but-answerable: **31** of 120 answerable questions (25.8%). Answered-wrong: **25**. False answers on gold-abstention: **2** of 30.

## Per-ability

| Ability | n | abstained-answerable | answered-wrong | correct |
|---|---:|---:|---:|---:|
| abstention | 30 | 0 | 0 | 28 |
| information_extraction | 38 | 18 | 3 | 17 |
| knowledge_update | 18 | 0 | 0 | 18 |
| multi_session | 31 | 4 | 8 | 19 |
| temporal | 33 | 9 | 14 | 10 |

## Per-question_type, all arms (this is the decisive cut)

`ability` folds the three single-session types into one column and hides where the deficit actually is. Split by the corpus's own `question_type`:

| question_type | n | errata | full_context | naive |
|---|---:|---:|---:|---:|
| knowledge-update | 24 | 100.0% | 62.5% | 87.5% |
| multi-session | 43 | 67.4% | 46.5% | 47.3% |
| single-session-assistant | 14 | 7.1% | 92.9% | 92.9% |
| single-session-preference | 8 | 0.0% | 20.8% | 0.0% |
| single-session-user | 22 | 100.0% | 100.0% | 77.3% |
| temporal-reasoning | 39 | 41.0% | 23.9% | 33.3% |

## Front-door diagnostics

- questions where NO question token matched a lexicon term: **4** of 150 (3%) — these anchor only via the first-person SELF entity, so the entity filter selects nothing.
- median claims reachable from the anchors: **318**, cut to a 30-claim material window.
- questions whose history has ZERO extracted claims: **0**.

## `A3_material_lacked_it` — 27 (abstained · synthesis saw material that did not contain the answer)

- **0a34ad58** (information_extraction)
  - Q: I’m a bit anxious about getting around Tokyo. Do you have any helpful tips?
  - gold: `The user would prefer responses that utilize their existing resources, such as their Suica card and TripIt app, to provide personalized tips for navigating Tokyo's public transportation. They might not prefer general tips or recommendations that do not take into account their prior preparations.`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens ['getting', 'around', 'tokyo', 'helpful', 'tips'] · unmatched ['bit', 'anxious', 'any']
  - 386 claims reachable / 532 in history; gold in material=False in graph=False
  - material head: ['board_game_start_time=late March', 'tennis_match_opponent=Rachel', 'tennis_match_opponent=Rachel', 'considering_dash_cam=getting a dash cam for their car']
- **1903aded** (information_extraction)
  - Q: I think we discussed work from home jobs for seniors earlier. Can you remind me what was the 7th job in the list you provided?
  - gold: `Transcriptionist.`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens ['work', 'home', 'jobs', 'seniors', 'job', 'list'] · unmatched ['think', 'discussed', 'earlier', 'remind', '7th', 'provided']
  - 310 claims reachable / 446 in history; gold in material=False in graph=False
  - material head: ['scale_model_start_date=started working on the model on 2023-05-08', 'model_project_start_time=started exactly three weeks before 2023-05-29', 'job_title=is a male model', 'recommended_section_5=Provide career advice about gaining experience, building qualifications, and finding job opportunities']
- **1da05512** (information_extraction)
  - Q: I'm trying to decide whether to buy a NAS device now or wait. What do you think?
  - gold: `The user would prefer responses that take into account their current home network storage capacity issues and recent reliance on external hard drives, highlighting the potential benefits of a NAS device in addressing these specific needs. They might not prefer responses that ignore their current storage challenges or fail to consider their recent tech upgrades and priorities. Preferred responses would utilize the user's previous mentions of storage capacity issues and tech investments to inform their decision.`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens ['trying', 'nas', 'device', 'now', 'think'] · unmatched ['decide', 'whether', 'buy', 'wait']
  - 313 claims reachable / 489 in history; gold in material=False in graph=False
  - material head: ['purchased_gift=a silver necklace from Zara for their sister', 'planned_purchase=Shimano Ultegra pedals', 'planned_route_app=MapMyRide', 'preferred_route_planning_app=MapMyRide']
- **1de5cff2** (information_extraction)
  - Q: I was going through our previous conversation about high-end fashion brands, and I was wondering if you could remind me of the brand that uses wild rubber sourced from the Amazon rainforest?
  - gold: `Veja`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens ['through', 'high', 'wondering', 'uses', 'amazon'] · unmatched ['going', 'previous', 'conversation', 'end', 'fashion', 'brands', 'remind', 'brand', 'wild', 'rubber', 'sourced', 'rainforest']
  - 298 claims reachable / 460 in history; gold in material=False in graph=False
  - material head: ['watch_purchase_intention=plans to research brands and find the best fit', 'white_dress_shirt_price=$40', 'old_athletic_leggings_brand=Adidas', 'old_casual_shoes_brand=Converse']
- **2bf43736** (information_extraction)
  - Q: I was going through our previous chat and I wanted to clarify something about the prayer of beginners in Tanqueray's Spiritual Life treatise. Can you remind me which chapter of the second part discusses vocal prayer and meditation?
  - gold: `Chapter 4 of Book 1, titled 'Vocal Prayer and Meditation'.`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens ['through', 'beginners', 'life', 'chapter'] · unmatched ['going', 'previous', 'chat', 'wanted', 'clarify', 'something', 'prayer', 'tanqueray', 'spiritual', 'treatise', 'remind', 'second', 'part', 'discusses', 'vocal', 'prayer', 'meditation']
  - 331 claims reachable / 468 in history; gold in material=False in graph=False
  - material head: ['visited_destination=Hawaii', 'acm_student_chapter_role=Vice President of the Association for Computing Machinery student chapter for one year', 'wants_to_use_yoga_for_recovery=use yoga to aid recovery after a long bike ride or run', "bulb_replacement_count=The current lamp's bulb had been replaced twice, including a replacement about three weeks earlier"]
- **352ab8bd** (information_extraction)
  - Q: Can you remind me what was the average improvement in framerate when using the Hardware-Aware Modular Training (HAMT) agent in the 'To Adapt or Not to Adapt? Real-Time Adaptation for Semantic Segmentation' submission?
  - gold: `The average improvement in framerate was approximately 20% when using the Hardware-Aware Modular Training (HAMT) agent.`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens ['improvement', 'using', 'hardware', 'aware', 'modular', 'training', 'agent', 'adapt', 'adapt', 'real', 'time', 'adaptation', 'semantic', 'segmentation', 'submission'] · unmatched ['remind', 'average', 'framerate', 'hamt']
  - 308 claims reachable / 473 in history; gold in material=False in graph=False
  - material head: ['fish_feeding_schedule=morning and evening', 'living_room_couch_relocation_duration=a few weeks', 'fish_feeding_schedule=twice a day, morning and evening', 'living_room_couch_location=has the couch on the opposite wall']
- **38146c39** (information_extraction)
  - Q: I've been feeling like my chocolate chip cookies need something extra. Any advice?
  - gold: `The user would prefer responses that build upon their previous experimentation with turbinado sugar, suggesting ingredients or techniques that complement its richer flavor. They might not prefer generic cookie-making advice or suggestions that don't take into account their existing use of turbinado sugar.`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens ['feeling', 'like', 'need'] · unmatched ['ve', 'chocolate', 'chip', 'cookies', 'something', 'extra', 'any', 'advice']
  - 341 claims reachable / 501 in history; gold in material=False in graph=False
  - material head: ['anxiety_attack_physical_symptoms=Heart racing and feeling unable to breathe', 'travel_preference=likes to stay active while traveling', 'cooking_class_interest=is interested in cooking classes focused on Korean or Thai cooking', 'enjoys_seasonal_wardrobe_refreshes=refreshing their wardrobe for a new season']
- **5809eb10** (information_extraction)
  - Q: I'm looking back at our previous conversation about the Bajimaya v Reward Homes Pty Ltd case. Can you remind me what year the construction of the house began?
  - gold: `2014.`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens ['back', 'conversation', 'bajimaya', 'reward', 'homes', 'pty', 'ltd', 'case', 'year'] · unmatched ['looking', 'previous', 'remind', 'construction', 'house', 'began']
  - 345 claims reachable / 511 in history; gold in material=False in graph=True
  - material head: ['case_citation=[2021] NSWCATAP 297', 'tribunal_findings=Reward Homes Pty Ltd breached its contract by failing to complete work properly, follow plans and specifications, and comply with the Building Code of Australia', 'has_coworker=coworker', 'chiefs_following_start=since the Divisional Round']
- **60159905** (multi_session)
  - Q: How many dinner parties have I attended in the past month?
  - gold: `three`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens ['dinner', 'parties', 'past'] · unmatched ['many', 'attended', 'month']
  - 388 claims reachable / 511 in history; gold in material=False in graph=True
  - material head: ['attended_event=pre-departure orientation at their university', 'university_orientation_attendance=attended a pre-departure orientation at their university', "past_event=attended a BBQ at Mike's place, watched a football game, and had it two weeks before 2023-05-21", "birthday_party_activity=played laser tag and sang karaoke at colleague and friend David's birthday party"]
- **7161e7e2** (information_extraction)
  - Q: I'm checking our previous chat about the shift rotation sheet for GM social media agents. Can you remind me what was the rotation for Admon on a Sunday?
  - gold: `Admon was assigned to the 8 am - 4 pm (Day Shift) on Sundays.`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens ['admon'] · unmatched ['checking', 'previous', 'chat', 'shift', 'rotation', 'sheet', 'gm', 'social', 'media', 'agents', 'remind', 'rotation', 'sunday']
  - 264 claims reachable / 425 in history; gold in material=False in graph=False
  - material head: ['content_topic=book-related social media content', 'twitter_book_chat_participation=participates in the weekly #BookClubChat on Twitter', 'something_rotten_soundtrack_interest=plans to check out the Something Rotten! soundtrack', 'hadestown_interest=is interested in the Hadestown cast album and possibly seeing the show live']

## `A4_material_had_it` — 4 (abstained · the answering claim WAS in the material (over-refusal))

- **6ae235be** (information_extraction)
  - Q: I remember you told me about the refining processes at CITGO's three refineries earlier. Can you remind me what kind of processes are used at the Lake Charles Refinery?
  - gold: `Atmospheric distillation, fluid catalytic cracking (FCC), alkylation, and hydrotreating.`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens ['processes', 'citgo', 'three', 'refineries', 'processes', 'lake', 'charles', 'refinery'] · unmatched ['remember', 'told', 'refining', 'earlier', 'remind', 'kind', 'used']
  - 270 claims reachable / 416 in history; gold in material=True in graph=True
  - material head: ['funko_pop_preorder=pre-ordered the Doctor Strange Funko Pop online four months earlier', 'job_title=senior manager', 'job_title=senior manager', 'stay_duration=three nights']
- **7024f17c** (multi_session)
  - Q: How many hours of jogging and yoga did I do last week?
  - gold: `0.5 hours`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens ['yoga', 'week'] · unmatched ['many', 'hours', 'jogging', 'last']
  - 368 claims reachable / 500 in history; gold in material=True in graph=True
  - material head: ['current_yoga_status=has been slacking off on yoga during this month', 'flight_delays_last_month=2 delays', 'flight_cancellations_last_month=1 cancellation', 'business_trips_by_air_past_month=5 trips']
- **gpt4_9a159967** (temporal)
  - Q: Which airline did I fly with the most in March and April?
  - gold: `United Airlines`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens ['airline', 'fly', 'march', 'april'] · unmatched ['most']
  - 341 claims reachable / 500 in history; gold in material=True in graph=True
  - material head: ['previous_flight=Took a direct Southwest Airlines flight from their hometown to Las Vegas in March', 'recent_united_trip=Took a business trip to Chicago with United Airlines in March, flying to Chicago on March 10 and returning on March 12, with two flights each way', 'recent_business_trip_itinerary=flew to Chicago on March 10 and returned on March 12, with two flights each way', 'recent_business_trip_destination=Chicago']
- **gpt4_e072b769** (temporal)
  - Q: How many weeks ago did I start using the cashback app 'Ibotta'?
  - gold: `3 weeks ago`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens ['many', 'weeks', 'ago', 'start', 'using', 'cashback', 'app', 'ibotta'] · unmatched []
  - 288 claims reachable / 406 in history; gold in material=True in graph=True
  - material head: ["best_friend_death=The user's best friend from childhood died in a car accident about three months before 2023-04-16.", 'ingredient_store_found=recently found a store carrying many needed ingredients', 'tennis_play_duration_with_coach=a few weeks', 'tennis_coach=Coach Thompson']

## `B1_wrong_claim_picked` — 7 (answered wrong · a gold-supporting claim was in the material)

- **0bc8ad93** (temporal)
  - Q: I mentioned visiting a museum two months ago. Did I visit with a friend or not?
  - gold: `No, you did not visit with a friend.`
  - errata: `You visited with a friend.`
  - matched tokens ['mentioned', 'museum', 'two', 'friend'] · unmatched ['visiting', 'months', 'ago', 'visit']
  - 288 claims reachable / 449 in history; gold in material=True in graph=True
  - material head: ['recent_learning_event=learned about Petra in a lecture at the History Museum about ancient civilizations', 'running_distance_progression_adherence=Has been able to stick to the one-mile-every-two-weeks increase', 'running_distance_progression=Increasing running distance by 1 mile every two weeks', 'running_distance_progression=increase by 1 mile every two weeks']
- **370a8ff4** (temporal)
  - Q: How many weeks had passed since I recovered from the flu when I went on my 10th jog outdoors?
  - gold: `15`
  - errata: `12`
  - matched tokens ['passed', 'jog'] · unmatched ['many', 'weeks', 'since', 'recovered', 'flu', 'went', '10th', 'outdoors']
  - 241 claims reachable / 414 in history; gold in material=False in graph=True
  - material head: ['research_methods=created Kalman filters and linear regression decoders', 'audience_support_duration=3 months', 'owns_many_shoes=a lot of shoes', 'owns_many_sneakers=a lot of sneakers']
- **85fa3a3f** (multi_session)
  - Q: What is the total cost of the new food bowl, measuring cup, dental chews, and flea and tick collar I got for Max?
  - gold: `$50`
  - errata: `$45`
  - matched tokens ['new', 'food', 'dental', 'chews', 'max'] · unmatched ['total', 'cost', 'bowl', 'measuring', 'cup', 'flea', 'tick', 'collar', 'got']
  - 343 claims reachable / 495 in history; gold in material=True in graph=True
  - material head: ['new_jeans_purchase=bought a new pair of jeans from a trendy store downtown', 'favorite_jeans_altered=had their favorite pair of jeans altered and likes the new fit', 'max_flea_tick_collar_cost=$20, one-time expense', 'flea_and_tick_collar_cost=$20']
- **982b5123** (temporal)
  - Q: How many months ago did I book the Airbnb in San Francisco?
  - gold: `Five months ago`
  - errata: `three months`
  - matched tokens ['book', 'airbnb', 'san', 'francisco'] · unmatched ['many', 'months', 'ago']
  - 342 claims reachable / 503 in history; gold in material=True in graph=True
  - material head: ['previous_san_francisco_trip_duration=5 days', 'visited_city=San Francisco', 'bookshelf_fiction_placement=keeps fiction books on the top shelf', 'bookshelf_nonfiction_placement=keeps non-fiction books on the bottom shelf']
- **e4e14d04** (temporal)
  - Q: How long had I been a member of 'Book Lovers Unite' when I attended the meetup?
  - gold: `Two weeks`
  - errata: `Three weeks`
  - matched tokens ['long', 'member', 'book', 'lovers', 'unite', 'attended'] · unmatched ['meetup']
  - 310 claims reachable / 454 in history; gold in material=True in graph=True
  - material head: ['facebook_group_membership=Book Lovers Unite', 'facebook_group_membership=The user joined a Facebook group called "Book Lovers Unite" three weeks before 2023-05-28.', "attended_lecture=design thinking lecture at the university's innovation center", "attended_design_thinking_lecture=design thinking lecture at the university's innovation center"]
- **gpt4_4929293b** (temporal)
  - Q: What was the the life event of one of my relatives that I participated in a week ago?
  - gold: `my cousin's wedding`
  - errata: `Michael's engagement party`
  - matched tokens ['event', 'one', 'week'] · unmatched ['life', 'relatives', 'participated', 'ago']
  - 334 claims reachable / 485 in history; gold in material=False in graph=True
  - material head: ["event_attended=had fun at cousin Rachel's baby shower in February", 'planned_vacation_timing=a quick getaway in August lasting one week', 'phone_backup_last_date=last backed up phone data approximately six weeks before 2023-05-04', 'research_paper_submission=submitted a research paper on Artificial Intelligence in Healthcare to the International Journal of Medical Research three weeks before 2023-04-16']
- **gpt4_61e13b3c** (temporal)
  - Q: How many weeks passed between the time I sold homemade baked goods at the Farmers' Market for the last time and the time I participated in the Spring Fling Market?
  - gold: `3 weeks`
  - errata: `4`
  - matched tokens ['weeks', 'passed', 'time', 'baked', 'goods', 'market', 'last', 'time', 'time', 'spring', 'fling', 'market'] · unmatched ['many', 'between', 'sold', 'homemade', 'farmers', 'participated']
  - 295 claims reachable / 443 in history; gold in material=False in graph=True
  - material head: ['custom_ringtone_change_time=one week before 2023-01-27', 'planned_exercise_frequency=at least 3 times a week', 'exercise_frequency_goal=at least 3 times a week', 'whole_foods_focus=plans to focus on whole foods']

## `B2_extraction_gap` — 15 (answered wrong · no claim in the history supports the gold answer)

- **0a995998** (multi_session)
  - Q: How many items of clothing do I need to pick up or return from a store?
  - gold: `3`
  - errata: `1`
  - matched tokens ['items', 'clothing', 'need', 'pick', 'up', 'return', 'store'] · unmatched ['many']
  - 328 claims reachable / 518 in history; gold in material=False in graph=False
  - material head: ['item_return_or_exchange=got boots from Zara on February 5th, found them too small, exchanged them for a larger size, and has not picked them up yet', 'zara_boots_exchange=exchanged a pair of Zara boots and still needs to pick up the replacement pair', 'boot_exchange_status=The user exchanged boots from Zara on 2023-02-05 and still needs to pick up the new pair.', 'fabric_scraps=has many fabric scraps from old projects']
- **2b8f3739** (multi_session)
  - Q: What is the total amount of money I earned from selling my products at the markets?
  - gold: `$495`
  - errata: `$525`
  - matched tokens ['products', 'markets'] · unmatched ['total', 'amount', 'money', 'earned', 'selling']
  - 346 claims reachable / 506 in history; gold in material=False in graph=False
  - material head: ['car_insurance_provider_switched=switched to a different provider and saved some money', "farmers_market_sales=sold 12 bunches of fresh organic herbs at a farmers' market on May 15, 2023, earning $120", 'fresh_herb_sales_revenue=$120', 'fresh_herb_sales_count=12 bunches']
- **54026fce** (information_extraction)
  - Q: I've been thinking about ways to stay connected with my colleagues. Any suggestions?
  - gold: `The user would prefer responses that acknowledge their desire for social interaction and collaboration while working remotely, utilizing their previous experiences with company initiatives and team collaborations. They might prefer suggestions of virtual team-building activities, regular check-ins, or joining interest-based groups within the company. The user may not prefer generic suggestions that do not take into account their specific work situation or previous attempts at staying connected with colleagues.`
  - errata: `The user likes framing ideas as collaborative suggestions and wants everyone to share their thoughts.`
  - matched tokens [] · unmatched ['ve', 'thinking', 'ways', 'stay', 'connected', 'colleagues', 'any', 'suggestions']
  - 370 claims reachable / 520 in history; gold in material=False in graph=False
  - material head: ['attended_universal_halloween_event=attended a Universal Studios Halloween event on October 15', 'watch_last_worn=2023-02-05', 'planned_footwear=wear red pumps to a charity gala', 'medical_condition=herniated disc']
- **6b7dfb22** (information_extraction)
  - Q: I've been feeling a bit stuck with my paintings lately. Do you have any ideas on how I can find new inspiration?
  - gold: `The user would prefer responses that build upon their existing sources of inspiration, such as revisiting Instagram art accounts or exploring new techniques from online tutorials. They might also appreciate suggestions that revisit previous themes they found enjoyable, like painting flowers. The user would not prefer generic or vague suggestions for finding inspiration, and would likely appreciate responses that utilize their recent 30-day painting challenge experience.`
  - errata: `The user gets inspiration from social media.`
  - matched tokens ['feeling', 'paintings', 'any', 'ideas', 'find'] · unmatched ['ve', 'bit', 'stuck', 'lately', 'new', 'inspiration']
  - 324 claims reachable / 466 in history; gold in material=False in graph=False
  - material head: ['social_disconnection=has been feeling disconnected from their social circle and stuck in a rut', 'social_connectedness=feeling disconnected from their social circle', 'solo_activities=has been focusing on painting and video games, but finds them unfulfilling', 'rom_com_interest=interested in new rom-coms streaming on Disney+']
- **6e984301** (temporal)
  - Q: How many weeks have I been taking sculpting classes when I invested in my own set of sculpting tools?
  - gold: `3`
  - errata: `6 weeks`
  - matched tokens ['weeks', 'taking', 'sculpting', 'classes', 'invested', 'set', 'sculpting', 'tools'] · unmatched ['many', 'own']
  - 297 claims reachable / 450 in history; gold in material=False in graph=False
  - material head: ['thesis_project_workflow_tool=Asana', 'project_management_tool=Trello', 'project_management_tool_satisfaction=happy with Trello', 'project_management_tool=Trello']
- **8077ef71** (temporal)
  - Q: How many days ago did I attend a networking event?
  - gold: `26 days. 27 days (including the last day) is also acceptable.`
  - errata: `25`
  - matched tokens ['many', 'days', 'networking', 'event'] · unmatched ['ago', 'attend']
  - 337 claims reachable / 492 in history; gold in material=False in graph=False
  - material head: ['family_picnic_event=recently attended an annual family picnic in June and had a great time', "planned_reminder_events=friends' and family members' birthdays, baby showers, and other celebrations", 'office_charity_event_intention=is thinking about organizing a charity event at their office', 'charity_event_search_plan=will search online and use social media platforms to find charity events']
- **80ec1f4f** (multi_session)
  - Q: How many different museums or galleries did I visit in the month of February?
  - gold: `2`
  - errata: `1`
  - matched tokens ['different', 'museums', 'galleries', 'month'] · unmatched ['many', 'visit', 'february']
  - 300 claims reachable / 461 in history; gold in material=False in graph=False
  - material head: ['recently_returned_to_art=after attending a guided workshop at the Modern Art Museum in January', 'visited_natural_history_museum=Natural History Museum', 'art_exhibition_visit=visited The Art Cube for the opening night of the exhibition Disrupting Reality on February 15', 'art_gallery_visit=visited The Art Cube']
- **92a0aa75** (multi_session)
  - Q: How long have I been working in my current role?
  - gold: `1 year and 5 months`
  - errata: `3 years and 9 months`
  - matched tokens ['working', 'current'] · unmatched ['long', 'role']
  - 300 claims reachable / 441 in history; gold in material=False in graph=False
  - material head: ['planned_hike_distance=about 5 miles', "values_hamilton_theme=the complexity of America's story and the integral role of people of color in it", 'wireless_earbuds_owned_duration=about 5 weeks', 'music_preference=mellow, laid-back indie rock']
- **95228167** (information_extraction)
  - Q: I'm getting excited about my visit to the music store this weekend. Any tips on what to look for in a new guitar?
  - gold: `The user would prefer responses that highlight the differences between Fender Stratocaster and Gibson Les Paul electric guitars, such as the feel of the neck, weight, and sound profile. They might not prefer general tips on buying an electric guitar or suggestions that do not take into account their current guitar and desired upgrade.`
  - errata: `The user is considering upgrading from a Fender Stratocaster to a Gibson Les Paul.`
  - matched tokens ['music', 'new', 'guitar'] · unmatched ['getting', 'excited', 'visit', 'store', 'weekend', 'any', 'tips', 'look']
  - 336 claims reachable / 499 in history; gold in material=False in graph=False
  - material head: ['pig_ownership=has pigs', 'pig_feed_research=is considering a new pig-feed brand and comparing its nutritional content with their current feed', 'grocery_purchase_store=Walmart', 'doctor_appointment_plan=schedule the appointment for 12:00 PM']
- **bc149d6b** (multi_session)
  - Q: What is the total weight of the new feed I purchased in the past two months?
  - gold: `70 pounds`
  - errata: `50 pounds`
  - matched tokens ['new', 'feed', 'two', 'months'] · unmatched ['total', 'weight', 'purchased', 'past']
  - 303 claims reachable / 464 in history; gold in material=False in graph=False
  - material head: ['purchased_item=black leather boots from Zara', 'recent_yellowstone_trip_duration=5 days', 'stage_production_attended=The Glass Menagerie at a local theater company', 'layer_feed_batch_weight=50 pounds']

## `B3_judge_rejected` — 3 (answered wrong · answer text contains the gold answer (judge call))

- **gpt4_59149c78** (temporal)
  - Q: I mentioned that I participated in an art-related event two weeks ago. Where was that event held at?
  - gold: `The Metropolitan Museum of Art.`
  - errata: `City Art Museum`
  - matched tokens ['participated', 'art', 'event', 'weeks', 'event'] · unmatched ['mentioned', 'related', 'two', 'ago', 'held']
  - 294 claims reachable / 457 in history; gold in material=True in graph=True
  - material head: ['replaced_lamp_bulbs=replaced burned-out bulbs in lamps', 'tiger_king_viewing_event=finished Tiger King in one weekend on Netflix', "handmade_blanket=made a cozy blanket for their niece's birthday", 'netflix_usage_duration=about two years']
- **gpt4_7abb270c** (temporal)
  - Q: What is the order of the six museums I visited from earliest to latest?
  - gold: `Science Museum, Museum of Contemporary Art, Metropolitan Museum of Art, Museum of History, Modern Art Museum, Natural History Museum`
  - errata: `Science Museum, Museum of Contemporary Art, Metropolitan Museum of Art, Modern Art Museum, Castello di Amorosa, Natural History Museum`
  - matched tokens ['museums', 'visited'] · unmatched ['order', 'six', 'earliest', 'latest']
  - 384 claims reachable / 536 in history; gold in material=True in graph=True
  - material head: ['ordered_wall_art=prints from Society6', 'ordered_wall_art_prints_from=Society6', "science_museum_visit=visited the Science Museum's Space Exploration exhibition", "visited_exhibition=Science Museum's “Space Exploration” exhibition with colleague David"]
- **gpt4_e414231f** (temporal)
  - Q: Which bike did I fixed or serviced the past weekend?
  - gold: `road bike`
  - errata: `The user fixed a flat tire on their mountain bike by replacing the inner tube and cleaning the chain, and they planned to take their road bike in for a maintenance check.`
  - matched tokens ['bike', 'past'] · unmatched ['fixed', 'serviced', 'weekend']
  - 298 claims reachable / 460 in history; gold in material=True in graph=True
  - material head: ['job_title=software engineering manager / intelligent automation team manager', 'list_item_1=Arrival (2016): Louise Banks learns an alien language that changes her perception of time and must reconcile her past and future', 'preferred_recommendation_basis=morally ambiguous storylines, flawed characters, and complex decision making', 'owned_streaming_equipment=a new microphone and a ring light']

## `C_false_answer` — 2 (answered a gold-abstention question)

- **6456829e_abs** (abstention)
  - Q: How many plants did I initially plant for tomatoes and chili peppers?
  - gold: `The information provided is not enough. You mentioned planting 5 plants for tomatoes but you did not mention chili peppers.`
  - errata: `5 tomato plants`
  - matched tokens ['many', 'plants', 'plant', 'tomatoes', 'peppers'] · unmatched ['initially', 'chili']
  - 220 claims reachable / 413 in history; gold in material=False in graph=False
  - material head: ['bathroom_renovation_plan=is considering redoing the bathroom', 'discarded_phone_chargers_count=three old phone chargers', 'tomato_plants_initially_planted=5 plants', 'tomato_plant_count=5 tomato plants']
- **a96c20ee_abs** (abstention)
  - Q: At which university did I present a poster for my undergrad course research project?
  - gold: `The information provided is not enough. You did not mention presenting a poster for your undergrad course research project.`
  - errata: `Harvard University`
  - matched tokens ['university', 'research'] · unmatched ['present', 'poster', 'undergrad', 'course', 'project']
  - 292 claims reachable / 472 in history; gold in material=False in graph=False
  - material head: ['thesis_research_poster_presentation=presented a poster on thesis research in education technology at a first research conference', 'conference_feedback=the user received substantial positive feedback from educators and policymakers after presenting the research at a conference over the summer', 'research_finding=AI-powered adaptive learning systems can improve student learning outcomes, but classroom implementation and integration require careful consideration', 'research_focus=the effectiveness of AI-powered adaptive learning systems in improving student learning outcomes in math and reading comprehension']

