// Python C_Audit.py의 business_days_between()을 그대로 옮긴 것.
// 날짜 계산은 로컬 타임존/DST에 따라 하루씩 밀리는 사고가 잘 나므로, 항상 UTC 기준
// Date(연/월/일만)로 다룬다 - "몇 시인지"는 여기서 의미가 없고 "어느 날짜인지"만 중요하다.

import { KR_HOLIDAY_DATES } from "./krHolidays.js";

/**
 * ISO 8601 날짜/시각 문자열에서 날짜 부분만 뽑아 UTC 기준 Date로 만든다.
 * (Python의 datetime.fromisoformat(...).date()와 동일 - 문자열에 적힌 날짜를 그대로 쓰고
 * 타임존 변환은 하지 않는다. toYYMMDD와 같은 이유.)
 */
function parseDateOnly(isoDatetimeStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDatetimeStr || "");
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** UTC 기준 Date를 "YYYY-MM-DD"로 포맷한다 (Python str(date)와 동일한 표기). */
function formatDateOnly(date) {
  if (!date) return "";
  return date.toISOString().slice(0, 10);
}

/** start와 end 사이의 영업일 수(주말·대한민국 공휴일 제외)를 센다. start/end는 Date 객체. */
function businessDaysBetweenDates(start, end) {
  if (!start || !end || end <= start) return 0;
  let total = 0;
  const current = new Date(start.getTime());
  current.setUTCDate(current.getUTCDate() + 1);
  while (current <= end) {
    const dow = current.getUTCDay(); // 0=일 ... 6=토
    const isWeekday = dow >= 1 && dow <= 5;
    if (isWeekday && !KR_HOLIDAY_DATES.has(formatDateOnly(current))) {
      total += 1;
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return total;
}

/** ISO 날짜/시각 문자열 두 개를 받아 바로 영업일 수를 센다. */
function businessDaysBetween(startIso, endIso) {
  return businessDaysBetweenDates(parseDateOnly(startIso), parseDateOnly(endIso));
}

export { parseDateOnly, formatDateOnly, businessDaysBetweenDates, businessDaysBetween };
