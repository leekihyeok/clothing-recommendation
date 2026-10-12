import { HttpException } from '@nestjs/common';
import { GraphQLError, type GraphQLFormattedError } from 'graphql';
import { lang } from './lang';

/**
 * English for the API's error messages (thrown in Korean all over the services). GraphQL's formatError runs them
 * through here when the request asked for English; a message not listed stays Korean. Add a line when you add a
 * user-facing error.
 */
const EXACT: Record<string, string> = {
  '500자 안으로 적어 주세요': 'Please keep it under 500 characters',
  'JPG 사진만 올릴 수 있어요': 'Only JPG photos can be uploaded',
  'JPG, PNG, WEBP 사진만 돼요': 'Only JPG, PNG or WEBP photos',
  'JPG, PNG, WEBP 사진만 올릴 수 있어요': 'Only JPG, PNG or WEBP photos can be uploaded',
  'cafe 또는 food만 넣을 수 있어요': 'Only a café or a place to eat can be added',
  '가게나 코스를 찾지 못했어요': "Couldn't find that shop or route",
  '가게를 찾지 못했어요': "Couldn't find that shop",
  '같이 가기 링크를 찾지 못했어요': "Couldn't find that invite link",
  '계정을 찾지 못했어요': "Couldn't find the account",
  '관리자만 볼 수 있어요': 'Admins only',
  '관리자만 할 수 있어요': 'Admins only',
  '그 가게를 찾지 못했어요 (문을 닫았거나 정보가 없는 곳일 수 있어요)': "Couldn't find that shop (it may have closed, or we don't know it yet)",
  '끝나는 날은 오늘이나 그 뒤로 골라 주세요': 'Pick an end date from today on',
  '끝나는 시각 형식이 맞지 않아요': "That finish time isn't valid",
  '대표자 이름을 적어 주세요': "Please enter the owner's name",
  '로그인이 필요해요': 'Please log in first',
  '마지막 한 곳은 뺄 수 없어요': "The last shop can't be removed",
  '별점은 1~5개로 골라 주세요': 'Pick 1 to 5 stars',
  '브라우저 저장소를 쓸 수 없어서 기록할 수 없어요': "Can't save this: your browser's storage is off",
  '사업자등록번호 10자리를 확인해 주세요': 'Please check the 10-digit business number',
  '사진이 너무 커요': 'The photo is too large',
  '사진이 너무 커요. 다른 사진을 골라 주세요': 'The photo is too large. Please pick another one',
  '소식 종류를 골라 주세요': 'Pick a kind of post',
  '어떻게 고칠지 적어 주세요': 'Tell us what to change',
  '연락받을 전화번호나 이메일을 적어 주세요': 'Please enter a phone number or email to reach you',
  '요일 7개의 영업시간을 모두 정해 주세요': 'Please set opening hours for all 7 days',
  '원하는 코스를 적어 주세요': 'Tell us what kind of route you want',
  '웹사이트 주소를 확인해 주세요 (예: https://myshop.com)': 'Please check the website address (e.g. https://myshop.com)',
  '이 가게의 사장님만 고칠 수 있어요': "Only this shop's owner can edit it",
  '이 가게의 사장님만 소식을 올릴 수 있어요': "Only this shop's owner can post news",
  '이 가게의 사장님만 지울 수 있어요': "Only this shop's owner can delete it",
  '이미 신청해서 확인을 기다리는 중이에요': "You've already applied; it's being checked",
  '이미 이 가게의 사장님으로 등록돼 있어요': "You're already registered as this shop's owner",
  '이미 처리했거나 없는 신청이에요': 'That request was already handled or no longer exists',
  '이미 코스에 있는 가게예요': "That shop is already in the route",
  '인스타그램 아이디를 확인해 주세요': 'Please check the Instagram handle',
  '제목을 적어 주세요': 'Please add a title',
  '지역을 찾지 못했어요': "Couldn't find that area",
  '처음 코스를 찾지 못했어요': "Couldn't find the original route",
  '출발 시각 형식이 맞지 않아요': "That start time isn't valid",
  '출발 시각을 알아보지 못했어요': "Couldn't read that start time",
  '출발 시각이 이미 지났어요': 'That start time has already passed',
  '출발점을 정해 주세요 (내 위치, 지역, 지도에서 고르기)': 'Pick a start: your location, an area, or a spot on the map',
  '코스 버전을 찾지 못했어요': "Couldn't find that version of the route",
  '코스를 찾지 못했어요': "Couldn't find that route",
  '코스에 있는 가게만 고정할 수 있어요': 'Only shops in the route can be pinned',
  '코스의 가게 정보를 찾지 못했어요': "Couldn't find that shop's details in the route",
  '판정은 good, wrong_style, wrong_info, closed 중 하나예요': 'Verdict must be good, wrong_style, wrong_info or closed',
  '후기는 1,000자 안으로 써 주세요': 'Please keep reviews under 1,000 characters',
  '되돌릴 고치기가 없어요': 'Nothing to undo',
  '평가는 좋았어요·그저 그랬어요·별로였어요 중 하나예요': 'Pick good, so-so or not great',
  '한 줄은 300자 안으로 써 주세요': 'Please keep it under 300 characters',
  '어떻게 고칠지 잘 모르겠어요. 다르게 말해 주세요': "Not sure what to change. Try saying it another way",
  '요청이 너무 많아요. 잠시 뒤 다시 해 주세요': 'Too many requests. Please try again in a moment',
  '잠시 문제가 생겼어요. 다시 해 주세요': 'Something went wrong. Please try again',
  '사업자등록증 사진을 올려 주세요': 'Please add a photo of your business registration certificate',
  '지금 지도 화면 안에는 추천할 가게가 없어요. 지도를 옮기거나 조금 넓혀 주세요': 'No shops to suggest in this part of the map. Move or zoom out a little',
  '이 근처에서 추천할 가게를 찾지 못했어요. 다른 지역을 골라 주세요': 'No shops to suggest around here. Try another area',
  'AI가 지금 붐벼요. 잠시 뒤 다시 해 주세요. 지역과 칩으로 고르면 바로 짤 수 있어요': 'The AI is busy right now. Try again shortly, or pick an area and chips to plan right away',
};

const DAY_EN: Record<string, string> = { 월: 'Monday', 화: 'Tuesday', 수: 'Wednesday', 목: 'Thursday', 금: 'Friday', 토: 'Saturday', 일: 'Sunday' };

const PATTERNS: [RegExp, (...m: string[]) => string][] = [
  [/^(.)요일 여는 시간과 닫는 시간을 00:00 형식으로 적어 주세요$/, (_, d) => `Enter ${DAY_EN[d] ?? d} opening and closing times as 00:00`],
  [/^(\d+|\?)번 가게가 코스에 없어요$/, (_, k) => `There's no #${k} in the route`],
  [/^(\d+)곳까지만 넣을 수 있어요$/, (_, n) => `Up to ${n} shops`],
  [/^(.+?)(?:은|는) 이 코스에서 너무 멀어요$/, (_, x) => `${x} is too far from this route`],
  [/^같이 가기는 (\d+)명까지예요$/, (_, n) => `Up to ${n} people can join`],
  [/^고정은 (\d+)곳까지예요\. 다른 가게의 고정을 풀어 주세요$/, (_, n) => `You can pin up to ${n} shops. Unpin one first`],
  [/^끝나는 시각\((.+?)\)이 출발\((.+?)\)보다 30분 이상 뒤여야 해요$/, (_, a, b) => `The finish (${a}) must be at least 30 minutes after the start (${b})`],
  [/^닉네임은 (\d+)~(\d+)자로 정해 주세요$/, (_, a, b) => `Nicknames are ${a}–${b} characters`],
  [/^모르는 고치기예요: (.+)$/, (_, x) => `Unknown edit: ${x}`],
  [/^모르는 기록이에요: (.+)$/, (_, x) => `Unknown action: ${x}`],
  [/^사진은 (\d+)장까지예요$/, (_, n) => `Up to ${n} photos`],
  [/^소식은 하루 (\d+)개까지 올릴 수 있어요$/, (_, n) => `Up to ${n} posts a day`],
  [/^출발은 (\d+)일 안으로 골라 주세요$/, (_, n) => `Pick a start within ${n} days`],
];

export function messageEn(message: string): string {
  if (EXACT[message]) return EXACT[message];
  for (const [re, f] of PATTERNS) {
    const m = re.exec(message);
    if (m) return f(...m);
  }
  return message;
}

const PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * Was this error thrown on purpose with a message for the user? Nest exceptions (BadRequestException …) and the
 * GraphQL errors with a code that the rate limiter and validation throw are; anything else is a bug or an outage
 * (a DB error, a failed fetch) whose text is for the log.
 */
function meantForUser(f: GraphQLFormattedError, error: unknown): boolean {
  const original = error instanceof GraphQLError ? error.originalError : error;
  if (original instanceof HttpException) return true;
  if (!original || original instanceof GraphQLError) return f.extensions?.code !== 'INTERNAL_SERVER_ERROR';
  return false;
}

/**
 * GraphQL formatError: the message in the request's language. In production an unexpected error shows a plain
 * "something went wrong" with only its code: no DB error text, file paths or stack.
 */
export function formatError(f: GraphQLFormattedError, error?: unknown): GraphQLFormattedError {
  let out = f;
  if (PRODUCTION && !meantForUser(f, error)) {
    out = { message: '잠시 문제가 생겼어요. 다시 해 주세요', locations: f.locations, path: f.path, extensions: { code: 'INTERNAL_SERVER_ERROR' } };
  }
  return lang() === 'en' ? { ...out, message: messageEn(out.message) } : out;
}
