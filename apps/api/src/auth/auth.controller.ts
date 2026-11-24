import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsEmail, IsString, IsOptional, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt.guard';
import { SupplierAccountService } from './supplier-account.service';

class SetPasswordDto {
  @IsString() @MinLength(10) token!: string;
  @IsString() password!: string;
}

class LoginDto {
  @IsEmail() email!: string;
  @IsOptional() @IsString() @MinLength(1) password?: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly suppliers: SupplierAccountService,
  ) {}

  @Post('login')
  async login(@Body() body: LoginDto) {
    return this.auth.login(body);
  }

  /** GET /auth/set-password/:token — public: is this supplier link usable, and for whom. */
  @Get('set-password/:token')
  async describeSetPassword(@Param('token') token: string) {
    return this.suppliers.describe(token);
  }

  /** POST /auth/set-password — public: consume the one-time link and set the password. */
  @Post('set-password')
  async setPassword(@Body() body: SetPasswordDto) {
    return this.suppliers.setPassword(body.token, body.password);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@Req() req: any) {
    return req.user;
  }
}
