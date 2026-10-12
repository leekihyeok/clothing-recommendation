import { Module } from '@nestjs/common';
import { CourseResolver } from './course.resolver';
import { CourseService } from './course.service';
import { ParseResolver } from './parse.resolver';
import { PresetsResolver } from './presets.resolver';
import { CourseGroupResolver } from './groups';

@Module({
  providers: [CourseResolver, CourseService, ParseResolver, PresetsResolver, CourseGroupResolver],
})
export class CourseModule {}
