import {
  BadRequestException, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { SupplierGuard } from '../supplier/supplier.guard';
import type { AuthenticatedUser } from '../auth/auth.service';
import { TendersService } from './tenders.service';

const u = (req: any) => {
  const x = req.user as AuthenticatedUser;
  return { id: x.id, role: x.role, costCenterIds: x.costCenterIds ?? [], vendorId: x.vendorId as string };
};

function sendFile(res: any, file: { stream: any; name: string; mimeType: string; size: number }, inline = false) {
  const safe = file.name.replace(/["\\]/g, '_');
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Length', String(file.size));
  res.setHeader('Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  file.stream.pipe(res);
}

/** Staff tender management: procurement's section, requesters' and HODs' requests. */
@UseGuards(JwtAuthGuard)
@Controller('tenders')
export class TendersController {
  constructor(private readonly svc: TendersService) {}

  /** GET /tenders/overview — ready-to-publish requests + every tender (procurement, CS). */
  @Get('overview')
  overview(@Req() req: any) { return this.svc.overview(u(req)); }

  /** GET /tenders/requests — tender requests visible to this user (requester, HOD, …). */
  @Get('requests')
  requests(@Req() req: any) { return this.svc.requests(u(req)); }

  /** GET /tenders/:rfqId — one tender with its bids (prices sealed until the deadline). */
  @Get(':rfqId')
  detail(@Param('rfqId', new ParseUUIDPipe()) rfqId: string, @Req() req: any) {
    return this.svc.detail(rfqId, u(req));
  }

  /** POST /tenders/:rfqId/documents — publish a document with the tender (raw body, x-file-name). */
  @Post(':rfqId/documents')
  upload(
    @Param('rfqId', new ParseUUIDPipe()) rfqId: string, @Req() req: any,
    @Headers('x-file-name') fileName: string, @Headers('content-type') contentType: string,
  ) {
    if (!fileName) { req.resume?.(); throw new BadRequestException('x-file-name is required'); }
    return this.svc.uploadDocument(rfqId, u(req), req, fileName, contentType);
  }

  /** DELETE /tenders/:rfqId/documents/:attachmentId — unpublish while the tender is open. */
  @Delete(':rfqId/documents/:attachmentId')
  remove(
    @Param('rfqId', new ParseUUIDPipe()) rfqId: string,
    @Param('attachmentId', new ParseUUIDPipe()) attachmentId: string, @Req() req: any,
  ) {
    return this.svc.removeDocument(rfqId, attachmentId, u(req));
  }
}

/** The public open-tender pages. No login. */
@Controller('public/tenders')
export class PublicTendersController {
  constructor(private readonly svc: TendersService) {}

  /** GET /public/tenders?status=open|closed|all */
  @Get()
  list(@Query('status') status?: string) { return this.svc.publicList(status); }

  @Get(':rfqId')
  detail(@Param('rfqId', new ParseUUIDPipe()) rfqId: string) { return this.svc.publicDetail(rfqId); }

  /** GET /public/tenders/:rfqId/documents/:attachmentId — a published tender document. */
  @Get(':rfqId/documents/:attachmentId')
  async document(
    @Param('rfqId', new ParseUUIDPipe()) rfqId: string,
    @Param('attachmentId', new ParseUUIDPipe()) attachmentId: string,
    @Res() res: any,
  ) {
    sendFile(res, await this.svc.documentFile(rfqId, attachmentId));
  }
}

/** A supplier's view of one tender, and its bid document upload. */
@UseGuards(JwtAuthGuard, SupplierGuard)
@Controller('supplier/tenders')
export class SupplierTendersController {
  constructor(private readonly svc: TendersService) {}

  /** GET /supplier/tenders/:rfqId — tender, my eligibility, my bid. */
  @Get(':rfqId')
  detail(@Param('rfqId', new ParseUUIDPipe()) rfqId: string, @Req() req: any) {
    return this.svc.supplierDetail(rfqId, u(req));
  }

  /** POST /supplier/tenders/:rfqId/documents — my bid document (raw body, x-file-name). */
  @Post(':rfqId/documents')
  upload(
    @Param('rfqId', new ParseUUIDPipe()) rfqId: string, @Req() req: any,
    @Headers('x-file-name') fileName: string, @Headers('content-type') contentType: string,
  ) {
    if (!fileName) { req.resume?.(); throw new BadRequestException('x-file-name is required'); }
    return this.svc.supplierUpload(rfqId, u(req), req, fileName, contentType);
  }
}
