import { Args, Context, Field, ID, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { MeService, type Request } from './me.service';
import { ProfileService } from './profile.service';

@ObjectType({ description: '마이페이지 프로필 (로그인한 사람)' })
export class Profile {
  @Field()
  nickname: string;

  @Field({ nullable: true })
  avatarUrl?: string;

  @Field()
  joinedAt: Date;

  @Field(() => Int)
  savedCourses: number;

  @Field(() => Int)
  reviews: number;
}

@ObjectType()
export class MyReview {
  @Field(() => ID)
  id: string;

  @Field(() => Int)
  rating: number;

  @Field({ nullable: true })
  body?: string;

  @Field()
  updatedAt: Date;

  @Field(() => ID)
  shopId: string;

  @Field()
  shopName: string;

  @Field()
  category: string;
}

@ObjectType()
export class AccountDeleted {
  @Field({ description: '카카오 계정과 앱 연결도 끊었는가 (KAKAO_ADMIN_KEY가 있을 때)' })
  kakaoUnlinked: boolean;
}

@Resolver()
export class ProfileResolver {
  constructor(
    private readonly profiles: ProfileService,
    private readonly me: MeService,
  ) {}

  @Query(() => Profile, { nullable: true, description: '내 프로필. 로그인 전이면 null' })
  async myProfile(@Context('req') req: Request): Promise<Profile | null> {
    const userId = await this.me.sessionUser(req);
    return userId ? this.profiles.profile(userId) : null;
  }

  @Mutation(() => String, { description: '닉네임 바꾸기 (2~20자). 다음 카카오 로그인 때도 유지' })
  async updateNickname(@Args('nickname') nickname: string, @Context('req') req: Request): Promise<string> {
    return this.profiles.setNickname(await this.me.requireLogin(req), nickname);
  }

  @Mutation(() => String, { description: '프로필 사진 바꾸기: 브라우저에서 줄인 사진(base64). 새 사진 주소를 준다' })
  async updateAvatar(@Args('imageBase64') imageBase64: string, @Context('req') req: Request): Promise<string> {
    return this.profiles.setAvatar(await this.me.requireLogin(req), imageBase64);
  }

  @Mutation(() => Boolean, { description: '프로필 사진 지우기 (닉네임 첫 글자로)' })
  async removeAvatar(@Context('req') req: Request): Promise<boolean> {
    return this.profiles.removeAvatar(await this.me.requireLogin(req));
  }

  @Query(() => [MyReview], { description: '내가 쓴 후기' })
  async myReviews(@Context('req') req: Request): Promise<MyReview[]> {
    const userId = await this.me.sessionUser(req);
    return userId ? this.profiles.myReviews(userId) : [];
  }

  @Mutation(() => AccountDeleted, { description: '회원 탈퇴: 계정과 기록을 지운다 (되돌릴 수 없음)' })
  async deleteAccount(@Context('req') req: Request): Promise<AccountDeleted> {
    return this.profiles.deleteAccount(await this.me.requireLogin(req));
  }
}
