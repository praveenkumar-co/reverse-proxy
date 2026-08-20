Humko URL parse karne ki naubat hi kyun aayi? (Why parse URL?)

Reverse Proxy is not a simple router: A reverse proxy is a smart traffic coordinator. Config file (config.yaml) mein aapne alag-alag paths define kiye hain (jaise / for standard servers, /api for video-transcoder).
Dynamic Decision Making: Jab ek browser request bhejta hai (GET /api/users?id=123), tab reverse proxy ko instantly check karna padta hai:

Kis upstream backend server ko call forward karni hai (Routing matching)?

Is path par rate-limiting ke parameters kya hain?
Kya is query-params data ko cache karna hai ya nahi?
Path extraction: Agar hum URL ko parse karke usse path (/api/users) aur query parameter (?id=123) separate nahi karenge, toh proxy matching rules coordinate nahi kar payegi.

--------------

