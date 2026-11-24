import { Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { NotificationsService } from './notifications.service';

/** The header bell: my notifications, newest first, and marking them read. */
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  /** `GET /notifications?limit=20` -> `{ unread, items[] }` */
  @Get()
  async mine(@Req() req: any, @Query('limit') limit?: string) {
    return this.svc.mine(req.user.id, Number(limit) || 20);
  }

  /** `POST /notifications/read-all` */
  @Post('read-all')
  async readAll(@Req() req: any) {
    return this.svc.markAllRead(req.user.id);
  }

  /** `POST /notifications/:id/read` */
  @Post(':id/read')
  async read(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: any) {
    return this.svc.markRead(req.user.id, id);
  }
}
