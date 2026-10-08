-- Shop owners: a Kakao-logged-in person claims a shop with its business registration number (checked against the
-- National Tax Service API when DATA_GO_KR_SERVICE_KEY is set), an admin approves on /admin, and the owner can then
-- keep the shop's hours, intro, photos and links up to date. Owner hours also feed course planning (stage G).
CREATE TABLE shop_owner_claims (
    id           bigserial PRIMARY KEY,
    shop_id      bigint      NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
    user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    business_no  text        NOT NULL,              -- 10 digits
    owner_name   text        NOT NULL,
    contact      text        NOT NULL,
    message      text,
    nts          jsonb,                             -- the tax service's answer (b_stt, tax_type …), null = not checked
    status       text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
    review_note  text,
    reviewed_by  uuid REFERENCES users (id) ON DELETE SET NULL,
    reviewed_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX shop_owner_claims_open_idx ON shop_owner_claims (shop_id, user_id) WHERE status = 'pending';
CREATE INDEX shop_owner_claims_status_idx ON shop_owner_claims (status, created_at);

CREATE TABLE shop_owners (
    shop_id     bigint      NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
    user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    claim_id    bigint REFERENCES shop_owner_claims (id) ON DELETE SET NULL,
    approved_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (shop_id, user_id)
);

-- What the owner keeps up to date. hours: 7 entries Mon..Sun, each {"closed": bool, "open": "11:00", "close": "21:00"}.
CREATE TABLE shop_owner_info (
    shop_id     bigint PRIMARY KEY REFERENCES shops (id) ON DELETE CASCADE,
    hours       jsonb,
    hours_note  text,          -- "매월 마지막 월요일 휴무" …
    intro       text CHECK (length(intro) <= 1000),
    instagram   text,
    phone       text,
    photos      text[] NOT NULL DEFAULT '{}',   -- paths under the upload folder, first is the cover
    updated_by  uuid REFERENCES users (id) ON DELETE SET NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);
