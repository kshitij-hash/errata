# Failure taxonomy — Errata arm, run `rerunA-synth`

150 questions (the seeded comparison-150). The arm is deterministic across the three seeds — 0 of 150 questions changed answer or verdict between seeds 11/22/33 — so the taxonomy is built once per question and multiplies by 3 for the 450-row totals.

## Counts

| Bucket | n | % of 150 | Meaning |
|---|---:|---:|---|
| `A1_no_anchor` | 1 | 0.7 | abstained · no entity anchor resolved (lexicon matched no question token) |
| `A2_no_attribute_fit` | 0 | 0.0 | abstained · anchors resolved but no claim scored above zero |
| `A3_material_lacked_it` | 39 | 26.0 | abstained · synthesis saw material that did not contain the answer |
| `A4_material_had_it` | 2 | 1.3 | abstained · the answering claim WAS in the material (over-refusal) |
| `A5_below_tau` | 0 | 0.0 | abstained · deterministic evidence score below tau |
| `B1_wrong_claim_picked` | 7 | 4.7 | answered wrong · a gold-supporting claim was in the material |
| `B2_extraction_gap` | 17 | 11.3 | answered wrong · no claim in the history supports the gold answer |
| `B3_judge_rejected` | 4 | 2.7 | answered wrong · answer text contains the gold answer (judge call) |
| `C_false_answer` | 3 | 2.0 | answered a gold-abstention question |
| `ok_answered` | 50 | 33.3 | answered and judged CORRECT |
| `ok_abstained` | 27 | 18.0 | abstained on a gold-abstention question |

Abstained-but-answerable: **42** of 120 answerable questions (35.0%). Answered-wrong: **28**. False answers on gold-abstention: **3** of 30.

## Per-ability

| Ability | n | abstained-answerable | answered-wrong | correct |
|---|---:|---:|---:|---:|
| abstention | 30 | 0 | 0 | 27 |
| information_extraction | 38 | 22 | 3 | 13 |
| knowledge_update | 18 | 1 | 1 | 16 |
| multi_session | 31 | 8 | 14 | 9 |
| temporal | 33 | 11 | 10 | 12 |

## Per-question_type, all arms (this is the decisive cut)

`ability` folds the three single-session types into one column and hides where the deficit actually is. Split by the corpus's own `question_type`:

| question_type | n | errata | full_context | naive |
|---|---:|---:|---:|---:|
| knowledge-update | 24 | 91.7% | 62.5% | 87.5% |
| multi-session | 43 | 46.5% | 46.5% | 47.3% |
| single-session-assistant | 14 | 0.0% | 92.9% | 92.9% |
| single-session-preference | 8 | 0.0% | 20.8% | 0.0% |
| single-session-user | 22 | 86.4% | 100.0% | 77.3% |
| temporal-reasoning | 39 | 41.0% | 23.9% | 33.3% |

## Front-door diagnostics

- questions where NO question token matched a lexicon term: **67** of 149 (45%) — these anchor only via the first-person SELF entity, so the entity filter selects nothing.
- median claims reachable from the anchors: **181**, cut to a 12-claim material window.
- questions whose history has ZERO extracted claims: **0**.

## `A1_no_anchor` — 1 (abstained · no entity anchor resolved (lexicon matched no question token))

- **2a1811e2** (temporal)
  - Q: How many days had passed between the Hindu festival of Holi and the Sunday mass at St. Mary's Church?
  - gold: `21 days. 22 days (including the last day) is also acceptable.`
  - errata: ABSTAINED (reason `no_anchor`)
  - matched tokens [] · unmatched ['many', 'days', 'passed', 'between', 'hindu', 'festival', 'holi', 'sunday', 'mass', 'st', 'mary', 'church']
  - 0 claims reachable / 212 in history; gold in material=False in graph=False
  - material head: []

## `A3_material_lacked_it` — 39 (abstained · synthesis saw material that did not contain the answer)

- **0a34ad58** (information_extraction)
  - Q: I’m a bit anxious about getting around Tokyo. Do you have any helpful tips?
  - gold: `The user would prefer responses that utilize their existing resources, such as their Suica card and TripIt app, to provide personalized tips for navigating Tokyo's public transportation. They might not prefer general tips or recommendations that do not take into account their prior preparations.`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens ['around', 'tokyo', 'helpful'] · unmatched ['bit', 'anxious', 'getting', 'any', 'tips']
  - 236 claims reachable / 240 in history; gold in material=False in graph=False
  - material head: ['considering_dash_cam=getting a dash cam for their car', 'sleep_insufficiency_effect=wakes up groggy and disoriented after getting less than 7 hours of sleep', 'travel_destination=Tokyo', 'planned_visit=Tokyo Tower']
- **1568498a** (information_extraction)
  - Q: I'm looking back at our previous chess game and I was wondering, what was the move you made after 27. Kg2 Bd5+?
  - gold: `28. Kg3`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens [] · unmatched ['looking', 'back', 'previous', 'chess', 'game', 'wondering', 'move', 'made', '27', 'kg2', 'bd5']
  - 162 claims reachable / 174 in history; gold in material=False in graph=False
  - material head: ['inherited_property_size=the inherited property is 5 acres', 'flooring_consideration=is considering LVT/LVP flooring', 'allergy_issues=has been experiencing allergy issues lately', 'planned_move_city=plans to move to Edinburgh']
- **1903aded** (information_extraction)
  - Q: I think we discussed work from home jobs for seniors earlier. Can you remind me what was the 7th job in the list you provided?
  - gold: `Transcriptionist.`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens [] · unmatched ['think', 'discussed', 'work', 'home', 'jobs', 'seniors', 'earlier', 'remind', '7th', 'job', 'list', 'provided']
  - 162 claims reachable / 167 in history; gold in material=False in graph=False
  - material head: ['job_title=is a male model', 'painting_purchase=recently purchased an abstract painting from a local artist at a gallery opening', 'commuting_to_work=commutes daily to and from work', 'had_protein_smoothie=protein smoothie from the café downstairs']
- **1da05512** (information_extraction)
  - Q: I'm trying to decide whether to buy a NAS device now or wait. What do you think?
  - gold: `The user would prefer responses that take into account their current home network storage capacity issues and recent reliance on external hard drives, highlighting the potential benefits of a NAS device in addressing these specific needs. They might not prefer responses that ignore their current storage challenges or fail to consider their recent tech upgrades and priorities. Preferred responses would utilize the user's previous mentions of storage capacity issues and tech investments to inform their decision.`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens [] · unmatched ['trying', 'decide', 'whether', 'buy', 'nas', 'device', 'now', 'wait', 'think']
  - 188 claims reachable / 195 in history; gold in material=False in graph=False
  - material head: ['has_partner=has a partner', 'finds_playlist_creation_exhausting=sometimes finds creating playlists exhausting and questions whether it is worth the time', 'packing_cube_choice=Eagle Creek Pack-It Cubes', 'purchased_streetwear_brand=Bricks and Wood']
- **1de5cff2** (information_extraction)
  - Q: I was going through our previous conversation about high-end fashion brands, and I was wondering if you could remind me of the brand that uses wild rubber sourced from the Amazon rainforest?
  - gold: `Veja`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens ['uses', 'amazon'] · unmatched ['going', 'through', 'previous', 'conversation', 'high', 'end', 'fashion', 'brands', 'wondering', 'remind', 'brand', 'wild', 'rubber', 'sourced', 'rainforest']
  - 176 claims reachable / 176 in history; gold in material=False in graph=False
  - material head: ['old_athletic_leggings_brand=Adidas', 'old_casual_shoes_brand=Converse', 'kitchenware_usage=Uses and enjoys the new pots and pans frequently', 'preferred_mug_shopping_stores=Plans to check Amazon and Zazzle for a new mug']
- **2b8f3739** (multi_session)
  - Q: What is the total amount of money I earned from selling my products at the markets?
  - gold: `$495`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens [] · unmatched ['total', 'amount', 'money', 'earned', 'selling', 'products', 'markets']
  - 186 claims reachable / 203 in history; gold in material=False in graph=False
  - material head: ['oil_level_status=looked a bit low', 'car_insurance_savings=saved money after switching car insurance providers', 'planned_skincare_products=is considering expanding the product line to include herbal face creams and body lotions', 'winter_coat_purchase_discount=bought a winter coat for 70% off at a warehouse sale at a local department store']
- **2bf43736** (information_extraction)
  - Q: I was going through our previous chat and I wanted to clarify something about the prayer of beginners in Tanqueray's Spiritual Life treatise. Can you remind me which chapter of the second part discusses vocal prayer and meditation?
  - gold: `Chapter 4 of Book 1, titled 'Vocal Prayer and Meditation'.`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens ['through', 'chapter'] · unmatched ['going', 'previous', 'chat', 'wanted', 'clarify', 'something', 'prayer', 'beginners', 'tanqueray', 'spiritual', 'life', 'treatise', 'remind', 'second', 'part', 'discusses', 'vocal', 'prayer', 'meditation']
  - 192 claims reachable / 192 in history; gold in material=False in graph=False
  - material head: ['student_organization_role=Vice President of the Association for Computing Machinery student chapter for one year', 'participated_in_cycling_event=Tour de Local, a 20-mile bike ride through nearby trails', 'participated_in_cycling_event=Tour de Local, a 20-mile bike ride through nearby trails', 'contemplative_prayer_interest=is interested in exploring contemplative prayer and meditation']
- **2e6d26dc** (multi_session)
  - Q: How many babies were born to friends and family members in the last few months?
  - gold: `5`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens ['family'] · unmatched ['many', 'babies', 'born', 'friends', 'members', 'last', 'few', 'months']
  - 1 claims reachable / 147 in history; gold in material=False in graph=False
  - material head: ['has_rare_genetic_disorder=a rare genetic disorder']
- **352ab8bd** (information_extraction)
  - Q: Can you remind me what was the average improvement in framerate when using the Hardware-Aware Modular Training (HAMT) agent in the 'To Adapt or Not to Adapt? Real-Time Adaptation for Semantic Segmentation' submission?
  - gold: `The average improvement in framerate was approximately 20% when using the Hardware-Aware Modular Training (HAMT) agent.`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens [] · unmatched ['remind', 'average', 'improvement', 'framerate', 'using', 'hardware', 'aware', 'modular', 'training', 'hamt', 'agent', 'adapt', 'adapt', 'real', 'time', 'adaptation', 'semantic', 'segmentation', 'submission']
  - 177 claims reachable / 179 in history; gold in material=False in graph=False
  - material head: ['meal_kit_exploration=is exploring meal kit services like Sun Basket to potentially save time and money', 'monday_actual_wake_time=07:00', 'monday_bedtime=23:00', 'autocross_lap_time=broke the 60-second barrier']
- **36580ce8** (information_extraction)
  - Q: What health issue did I initially think was just a cold?
  - gold: `bronchitis`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens [] · unmatched ['health', 'issue', 'initially', 'think', 'just', 'cold']
  - 164 claims reachable / 181 in history; gold in material=False in graph=True
  - material head: ['bird_identification_difficulty=having trouble distinguishing between Yellow Warblers and Common Yellowthroats', 'television_show_currently_watching=The Witcher', 'met_person=Maya, a graphic designer', 'desired_sleep_duration=7-8 hours per night']

## `A4_material_had_it` — 2 (abstained · the answering claim WAS in the material (over-refusal))

- **7024f17c** (multi_session)
  - Q: How many hours of jogging and yoga did I do last week?
  - gold: `0.5 hours`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens [] · unmatched ['many', 'hours', 'jogging', 'yoga', 'last', 'week']
  - 221 claims reachable / 221 in history; gold in material=True in graph=True
  - material head: ['flight_delays_last_month=2', 'flight_cancellations_last_month=1', 'music_festival_attendance=attended a music festival last month', 'yoga_restart_intention=is trying to resume yoga practice']
- **gpt4_61e13b3c** (temporal)
  - Q: How many weeks passed between the time I sold homemade baked goods at the Farmers' Market for the last time and the time I participated in the Spring Fling Market?
  - gold: `3 weeks`
  - errata: ABSTAINED (reason `synth_insufficient`)
  - matched tokens [] · unmatched ['many', 'weeks', 'passed', 'between', 'time', 'sold', 'homemade', 'baked', 'goods', 'farmers', 'market', 'last', 'time', 'time', 'participated', 'spring', 'fling', 'market']
  - 162 claims reachable / 164 in history; gold in material=True in graph=True
  - material head: ['guitar_teacher=has been taking guitar lessons with Alex for three weeks', 'living_room_furniture_rearranged=rearranged the furniture a few weeks ago', 'observed_cracks_in_house_walls_and_floors=noticed cracks in the walls and floors of the house during their last visit', "baked_goods_sales=sold homemade muffins, scones, and cookies at the Farmers' Market"]

## `B1_wrong_claim_picked` — 7 (answered wrong · a gold-supporting claim was in the material)

- **85fa3a3f** (multi_session)
  - Q: What is the total cost of the new food bowl, measuring cup, dental chews, and flea and tick collar I got for Max?
  - gold: `$50`
  - errata: `$45`
  - matched tokens ['max'] · unmatched ['total', 'cost', 'new', 'food', 'bowl', 'measuring', 'cup', 'dental', 'chews', 'flea', 'tick', 'collar', 'got']
  - 196 claims reachable / 204 in history; gold in material=False in graph=True
  - material head: ['flea_and_tick_collar_cost=$20', 'flea_and_tick_collar_expense_type=one-time expense', 'uses_dental_chews=yes', 'monthly_dental_chew_cost=$10']
- **982b5123** (temporal)
  - Q: How many months ago did I book the Airbnb in San Francisco?
  - gold: `Five months ago`
  - errata: `three`
  - matched tokens ['san', 'francisco'] · unmatched ['many', 'months', 'ago', 'book', 'airbnb']
  - 197 claims reachable / 204 in history; gold in material=True in graph=True
  - material head: ['visited_city=San Francisco', 'bookshelf_reorganization_date=reorganized their bookshelf about three weeks ago', 'snack_packing_experience=had snacks available during a delayed San Francisco flight and found them very helpful', 'planned_accommodation_neighborhood=Haight-Ashbury, San Francisco']
- **a08a253f** (multi_session)
  - Q: How many days a week do I attend fitness classes?
  - gold: `4 days.`
  - errata: `3`
  - matched tokens ['fitness', 'classes'] · unmatched ['many', 'days', 'week', 'attend']
  - 170 claims reachable / 182 in history; gold in material=True in graph=True
  - material head: ['japanese_classes=is taking Japanese classes', 'fitness_goals=is trying to stay on top of their fitness goals', 'dicks_sporting_goods_scorecard_qualifying_spend=spent over $200 on sporting goods and apparel in the past 90 days', 'family_members=parents, siblings, nieces, nephews, and close family friends']
- **e4e14d04** (temporal)
  - Q: How long had I been a member of 'Book Lovers Unite' when I attended the meetup?
  - gold: `Two weeks`
  - errata: `three weeks`
  - matched tokens ['book', 'lovers', 'unite', 'attended'] · unmatched ['long', 'member', 'meetup']
  - 172 claims reachable / 182 in history; gold in material=True in graph=True
  - material head: ['facebook_group_membership=Book Lovers Unite', 'book_meetup_attendance=attended a meetup organized by a group to discuss the book', 'attended_project_management_workshop=project management workshop', 'facebook_group_activity=active in the Facebook group "Book Lovers Unite"']
- **efc3f7c2** (multi_session)
  - Q: How much earlier do I wake up on Fridays compared to other weekdays?
  - gold: `30 minutes`
  - errata: `1.5 hours`
  - matched tokens ['up', 'weekdays'] · unmatched ['much', 'earlier', 'wake', 'fridays', 'compared', 'other']
  - 178 claims reachable / 181 in history; gold in material=False in graph=True
  - material head: ['design_thinking_lecture_attendance=attended a design thinking lecture at a university innovation center three weeks earlier', 'photo_booth_plan=plans to set up a designated photo booth area with a backdrop and props', 'sister=has a sister whose birthday is coming up soon', 'planned_trip_origin=San Francisco']
- **gpt4_21adecb5** (temporal)
  - Q: How many months passed between the completion of my undergraduate degree and the submission of my master's thesis?
  - gold: `6 months`
  - errata: `18`
  - matched tokens ['months', 'thesis'] · unmatched ['many', 'passed', 'between', 'completion', 'undergraduate', 'degree', 'submission', 'master']
  - 189 claims reachable / 205 in history; gold in material=True in graph=True
  - material head: ['bitters_collection=has a variety of bitters in their cabinet', 'reading_list_intention=plans to add The Hunger Games to their reading list', 'undergraduate_degree=completed an undergraduate degree in computer science', 'marathon_completion=completed a marathon']
- **gpt4_e414231f** (temporal)
  - Q: Which bike did I fixed or serviced the past weekend?
  - gold: `road bike`
  - errata: `mountain bike`
  - matched tokens [] · unmatched ['bike', 'fixed', 'serviced', 'past', 'weekend']
  - 170 claims reachable / 170 in history; gold in material=True in graph=True
  - material head: ['preferred_road_bike_pedals=Shimano Ultegra pedals', 'road_bike_maintenance_intent=plans to take the road bike in for a maintenance check', 'road_bike_brake_condition=the brakes feel spongy', "clipless_pedal_upgrade_intent=is considering upgrading the road bike's pedals to clipless pedals"]

## `B2_extraction_gap` — 17 (answered wrong · no claim in the history supports the gold answer)

- **0a995998** (multi_session)
  - Q: How many items of clothing do I need to pick up or return from a store?
  - gold: `3`
  - errata: `1`
  - matched tokens [] · unmatched ['many', 'items', 'clothing', 'need', 'pick', 'up', 'return', 'store']
  - 201 claims reachable / 215 in history; gold in material=False in graph=False
  - material head: ['zara_boots_exchange=exchanged a pair of Zara boots and still needs to pick up the replacement pair', 'waste_reduction_intention=plans to be more mindful of how they store and dispose of eco-friendly items', 'fabric_scraps=has many fabric scraps from old projects', 'enjoys_cooking_with_family=enjoys cooking together and catching up with their family']
- **0bc8ad93** (temporal)
  - Q: I mentioned visiting a museum two months ago. Did I visit with a friend or not?
  - gold: `No, you did not visit with a friend.`
  - errata: `The user visited the Natural History Museum with their dad.`
  - matched tokens ['museum', 'two', 'friend'] · unmatched ['mentioned', 'visiting', 'months', 'ago', 'visit']
  - 165 claims reachable / 166 in history; gold in material=False in graph=False
  - material head: ['has_a_friend_who_is_a_chemistry_professor=a friend who is a chemistry professor', 'museum_visits=has visited various museums in the past few months', 'shared_museum_experience=took a behind-the-scenes tour of the Science Museum with a friend, viewed rare minerals, and participated in a hands-on experiment', 'museum_event_interest=has been trying to attend museum events and exhibits in their area']
- **0f05491a** (knowledge_update)
  - Q: How many stars do I need to reach the gold level on my Starbucks Rewards app?
  - gold: `120`
  - errata: `125 stars`
  - matched tokens ['rewards'] · unmatched ['many', 'stars', 'need', 'reach', 'gold', 'level', 'starbucks', 'app']
  - 166 claims reachable / 169 in history; gold in material=False in graph=False
  - material head: ['planned_game_purchase=plans to pre-order Forbidden Sky', 'starbucks_gold_level_target=125 stars', 'uses_starbucks_rewards_app=uses the Starbucks Rewards app', "attended_event=a private tour of the Modern Art Museum's new contemporary exhibit"]
- **21d02d0d** (multi_session)
  - Q: How many fun runs did I miss in March due to work commitments?
  - gold: `2`
  - errata: `1`
  - matched tokens [] · unmatched ['many', 'fun', 'runs', 'miss', 'march', 'due', 'work', 'commitments']
  - 223 claims reachable / 228 in history; gold in material=False in graph=False
  - material head: ['missed_5k_fun_run=missed the run on March 5th due to work commitments', 'missed_event=missed a 5K fun run on March 26, 2023', 'late_night_project_work=staying up late to work on a project', 'work_project_whatsapp_use=uses WhatsApp extensively for a new work project and stays in constant touch with the team']
- **2788b940** (multi_session)
  - Q: How many fitness classes do I attend in a typical week?
  - gold: `5`
  - errata: `The material does not specify the exact number of fitness classes attended in a typical week, as it lists various classes (Zumba, Hip Hop Abs, yoga, BodyPump, sculpting) and specific schedules for some (Zumba on Tuesdays/Thursdays, BodyPump on Mondays, yoga on Sundays) without providing a complete weekly count or frequency for all mentioned activities.
INSUFFICIENT_INFORMATION: The history mentions attending Zumba, Hip Hop Abs, yoga, BodyPump, and sculpting classes, with specific days listed for Zumba, BodyPump, and yoga, but does not provide a total weekly count.`
  - matched tokens [] · unmatched ['many', 'fitness', 'classes', 'attend', 'typical', 'week']
  - 163 claims reachable / 191 in history; gold in material=False in graph=False
  - material head: ['fitness_classes=attends Zumba, Hip Hop Abs, yoga, and BodyPump classes', 'fitness_goals=has goals of increasing cardio endurance and improving strength', 'zumba_class_schedule=takes Zumba classes on Tuesdays and Thursdays at 7:00 PM', 'zumba_arrival_preference=arrives about 15 minutes early for Zumba classes to warm up']
- **370a8ff4** (temporal)
  - Q: How many weeks had passed since I recovered from the flu when I went on my 10th jog outdoors?
  - gold: `15`
  - errata: `10`
  - matched tokens [] · unmatched ['many', 'weeks', 'passed', 'since', 'recovered', 'flu', 'went', '10th', 'jog', 'outdoors']
  - 136 claims reachable / 150 in history; gold in material=False in graph=False
  - material head: ['research_methods=created Kalman filters and linear regression decoders', 'selected_travel_insurance_policy=Squaremouth Travel Basic', 'owns_many_shoes=a lot of shoes', 'owns_many_sneakers=a lot of sneakers']
- **54026fce** (information_extraction)
  - Q: I've been thinking about ways to stay connected with my colleagues. Any suggestions?
  - gold: `The user would prefer responses that acknowledge their desire for social interaction and collaboration while working remotely, utilizing their previous experiences with company initiatives and team collaborations. They might prefer suggestions of virtual team-building activities, regular check-ins, or joining interest-based groups within the company. The user may not prefer generic suggestions that do not take into account their specific work situation or previous attempts at staying connected with colleagues.`
  - errata: `The user misses social interactions and watercooler conversations with colleagues.`
  - matched tokens [] · unmatched ['ve', 'thinking', 'ways', 'stay', 'connected', 'colleagues', 'any', 'suggestions']
  - 230 claims reachable / 232 in history; gold in material=False in graph=False
  - material head: ['has_herniated_disc=herniated disc', 'recovering_from_an_unspecified_health_condition=is recovering and has been thinking about exercising', 'dinner_outfit_plan=is thinking of wearing the new dress to a dinner spot', 'rug_budget=around $200 to $300, depending on the size and quality']
- **6b7dfb22** (information_extraction)
  - Q: I've been feeling a bit stuck with my paintings lately. Do you have any ideas on how I can find new inspiration?
  - gold: `The user would prefer responses that build upon their existing sources of inspiration, such as revisiting Instagram art accounts or exploring new techniques from online tutorials. They might also appreciate suggestions that revisit previous themes they found enjoyable, like painting flowers. The user would not prefer generic or vague suggestions for finding inspiration, and would likely appreciate responses that utilize their recent 30-day painting challenge experience.`
  - errata: `The user has been getting inspiration from social media.`
  - matched tokens [] · unmatched ['ve', 'feeling', 'bit', 'stuck', 'paintings', 'lately', 'any', 'ideas', 'find', 'new', 'inspiration']
  - 188 claims reachable / 192 in history; gold in material=False in graph=False
  - material head: ['social_connectedness=feeling disconnected from their social circle', 'rom_com_interest=interested in new rom-coms streaming on Disney+', 'spider_man_funko_pop=owns a new Spider-Man Funko Pop', 'paints=the user makes paintings']
- **6e984301** (temporal)
  - Q: How many weeks have I been taking sculpting classes when I invested in my own set of sculpting tools?
  - gold: `3`
  - errata: `6`
  - matched tokens ['tools'] · unmatched ['many', 'weeks', 'taking', 'sculpting', 'classes', 'invested', 'own', 'set', 'sculpting']
  - 168 claims reachable / 168 in history; gold in material=False in graph=False
  - material head: ['voter_registration=has voter registration that needs to be updated with the new name', 'malpractice_insurance=has malpractice insurance that needs to be updated with the new name', 'keyword_tool_experience=They have not tried the other recommended keyword research tools', 'planned_keyword_research_tools=Google Keyword Planner, Ubersuggest, and LSIGraph']
- **80ec1f4f** (multi_session)
  - Q: How many different museums or galleries did I visit in the month of February?
  - gold: `2`
  - errata: `1`
  - matched tokens ['month'] · unmatched ['many', 'different', 'museums', 'galleries', 'visit', 'february']
  - 176 claims reachable / 182 in history; gold in material=False in graph=False
  - material head: ['art_gallery_visit=visited The Art Cube', 'cuisine_exploration_interest=loves trying different cuisines', 'posture_and_balance_improvement=has noticed improvements in posture and balance since starting ballet', 'crowd_preference=prefers to avoid crowds when visiting museums']

## `B3_judge_rejected` — 4 (answered wrong · answer text contains the gold answer (judge call))

- **129d1232** (multi_session)
  - Q: How much money did I raise in total through all the charity events I participated in?
  - gold: `$5,850`
  - errata: `$850`
  - matched tokens ['total'] · unmatched ['much', 'money', 'raise', 'through', 'all', 'charity', 'events', 'participated']
  - 160 claims reachable / 179 in history; gold in material=False in graph=False
  - material head: ['amazon_purchase_coupon_usage=Used a 20% off coupon on an Amazon online shopping order, saving around $25 on a $125 total bill', 'charity_fundraising_amount=$600 raised for a local animal shelter through the charity yoga event', 'charity_event_organizer=helped organize a charity yoga event', 'charity_event_planning=is considering organizing a charity event, such as a charity run or fundraising dinner']
- **d851d5ba** (multi_session)
  - Q: How much money did I raise for charity in total?
  - gold: `$3,750`
  - errata: `$1,750`
  - matched tokens [] · unmatched ['much', 'money', 'raise', 'charity', 'total']
  - 193 claims reachable / 196 in history; gold in material=False in graph=False
  - material head: ['charity_run_name=Run for Hunger', 'charity_fundraising_amount=$250', 'charity_run_distance_km=5 kilometers', 'charity_beneficiary=a local food bank']
- **gpt4_59149c78** (temporal)
  - Q: I mentioned that I participated in an art-related event two weeks ago. Where was that event held at?
  - gold: `The Metropolitan Museum of Art.`
  - errata: `Museum of Modern Art`
  - matched tokens ['art'] · unmatched ['mentioned', 'participated', 'related', 'event', 'two', 'weeks', 'ago', 'event', 'held']
  - 168 claims reachable / 178 in history; gold in material=True in graph=True
  - material head: ['netflix_subscription_duration=has used Netflix for about two years', 'modern_art_interest=is interested in modern art movements, especially 20th-century movements', 'museum_visit=recently attended a guided tour at the Museum of Modern Art focused on 20th-century modern art movements', 'pad_thai_preference=has eaten pad thai and loved it']
- **gpt4_7abb270c** (temporal)
  - Q: What is the order of the six museums I visited from earliest to latest?
  - gold: `Science Museum, Museum of Contemporary Art, Metropolitan Museum of Art, Museum of History, Modern Art Museum, Natural History Museum`
  - errata: `Science Museum, Metropolitan Museum of Art, Metropolitan Museum of Art, Metropolitan Museum of Art, Natural History Museum, Natural History Museum`
  - matched tokens [] · unmatched ['order', 'six', 'museums', 'visited', 'earliest', 'latest']
  - 225 claims reachable / 241 in history; gold in material=True in graph=True
  - material head: ["science_museum_visit=visited the Science Museum's Space Exploration exhibition", 'interest_in_collective_memory=collective memory and shared cultural and historical contexts', 'has_bookshelves=true', 'bedside_lamp_replacement_plan=is thinking of replacing old bedside lamps with modern-design lamps']

## `C_false_answer` — 3 (answered a gold-abstention question)

- **6456829e_abs** (abstention)
  - Q: How many plants did I initially plant for tomatoes and chili peppers?
  - gold: `The information provided is not enough. You mentioned planting 5 plants for tomatoes but you did not mention chili peppers.`
  - errata: `5 tomato plants`
  - matched tokens [] · unmatched ['many', 'plants', 'initially', 'plant', 'tomatoes', 'chili', 'peppers']
  - 126 claims reachable / 127 in history; gold in material=False in graph=False
  - material head: ['tomato_plant_count=5 tomato plants', 'tomato_plant_overwatering=had been overwatering tomato plants, then reduced the watering schedule', 'tomato_plant_recovery=tomato plants looked healthier after reducing watering', 'garden_tomato_plants=has tomato plants in a garden']
- **gpt4_70e84552_abs** (abstention)
  - Q: Which task did I complete first, fixing the fence or purchasing three cows from Peter?
  - gold: `The information provided is not enough. You mentioned fixing the fence but did not mention purchasing cows from Peter.`
  - errata: `fixing the fence`
  - matched tokens [] · unmatched ['task', 'complete', 'first', 'fixing', 'fence', 'purchasing', 'three', 'cows', 'peter']
  - 201 claims reachable / 206 in history; gold in material=False in graph=False
  - material head: ['social_media_break_end_date=2023-02-20', 'repaired_fence=broken fence on the east side of the property', 'goats_vaccinated_against_parasites=vaccinated against parasites', 'cow_purchase_planned=is considering purchasing a new cow']
- **gpt4_c27434e8_abs** (abstention)
  - Q: Which project did I start first, the Ferrari model or the Porsche 991 Turbo S model?
  - gold: `The information provided is not enough. You did not mention starting the Porsche 991 Turbo S model.`
  - errata: `The Ferrari model`
  - matched tokens ['ferrari'] · unmatched ['project', 'start', 'first', 'model', 'porsche', '991', 'turbo', 'model']
  - 184 claims reachable / 193 in history; gold in material=False in graph=False
  - material head: ['japanese_zero_model_start_date=started building the 1/48 scale Japanese Zero fighter plane about one month ago', 'applied_model_decals=pre-made Ferrari 288 GTO decals to the engine compartment and body', 'current_model_project=working on a Ferrari 288 GTO model', 'model_subject=Ferrari 288 GTO']

