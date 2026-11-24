// Open tender vendor lists: "Open Tenders" and "My Bids".
//
//   npm run test:web
//
// Renders the real components with react-dom/server and asserts on the markup,
// like supplier.render.test.tsx does for the invited-RFQ inbox.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import {
  OpenTendersList, MyBidsList, closesIn,
  type OpenTender, type MyBid,
} from '../components/supplier/TenderCards';

const NOW = Date.parse('2026-11-24T10:00:00Z');
const at = (hours: number) => new Date(NOW + hours * 3600e3).toISOString();

test('closesIn: days, hours, minutes, closed', () => {
  assert.equal(closesIn(at(50), NOW), 'closes in 2d 2h');
  assert.equal(closesIn(at(3.5), NOW), 'closes in 3h 30m');
  assert.equal(closesIn(at(0.25), NOW), 'closes in 15m');
  assert.equal(closesIn(at(0.001), NOW), 'closes in 1m');
  assert.equal(closesIn(at(-1), NOW), 'closed');
  assert.equal(closesIn('not a date', NOW), 'closed');
});

const tender: OpenTender = {
  rfqId: 't-1', rfqNumber: 'RFQ-2026-200100', title: 'Laptops for Sales',
  notes: 'Deliver to Karachi plant.', currency: 'PKR', issuedAt: at(-1),
  deadlineAt: at(26), lineCount: 2,
};

test('Open Tenders: lists a tender with its notes, countdown and a Bid now button', () => {
  const html = renderToStaticMarkup(h(OpenTendersList, { tenders: [tender], onBid: () => {}, nowMs: NOW }));
  assert.match(html, /RFQ-2026-200100/);
  assert.match(html, /Laptops for Sales/);
  assert.match(html, /Deliver to Karachi plant\./);
  assert.match(html, /closes in 1d 2h/);
  assert.match(html, /data-bid-now="t-1"/);
  assert.match(html, />Bid now</);
  assert.match(html, /bids are sealed/);
});

test('Open Tenders: busy row says Opening and is disabled', () => {
  const html = renderToStaticMarkup(h(OpenTendersList, { tenders: [tender], onBid: () => {}, busyId: 't-1', nowMs: NOW }));
  assert.match(html, /disabled=""[^>]*data-bid-now="t-1"|data-bid-now="t-1"[^>]*disabled=""/);
  assert.match(html, /Opening…/);
});

test('Open Tenders: empty state, never an empty table', () => {
  const html = renderToStaticMarkup(h(OpenTendersList, { tenders: [] }));
  assert.match(html, /No open tenders in your categories/);
  assert.doesNotMatch(html, /<table/);
});

const bids: MyBid[] = [
  {
    invitationId: 'i-1', rfqId: 't-1', rfqNumber: 'RFQ-2026-200100', title: 'Laptops',
    deadlineAt: at(26), currency: 'PKR', tenderState: 'Open',
    myBid: { version: 2, total: 83000 }, status: 'Submitted', canBid: true,
  },
  {
    invitationId: 'i-2', rfqId: 't-2', rfqNumber: 'RFQ-2026-200101', title: 'Chairs',
    deadlineAt: at(10), currency: 'PKR', tenderState: 'Open',
    myBid: null, status: 'Not submitted', canBid: true,
  },
  {
    invitationId: 'i-3', rfqId: 't-3', rfqNumber: 'RFQ-2026-200102', title: 'Desks',
    deadlineAt: at(-5), currency: 'PKR', tenderState: 'Closed',
    myBid: { version: 1, total: 50000 }, status: 'Tender closed', canBid: false,
  },
];

test('My Bids: one row per joined tender with my own bid and status', () => {
  const html = renderToStaticMarkup(h(MyBidsList, { bids, onOpen: () => {}, nowMs: NOW }));
  assert.match(html, /V2 · PKR 83,000/);
  assert.match(html, />Edit bid</);           // open, already bid
  assert.match(html, />Bid now</);            // open, not bid yet
  assert.match(html, />View</);               // closed
  assert.match(html, /Tender closed/);
  assert.match(html, /Not submitted/);
  // the countdown shows only while bidding is open
  assert.equal((html.match(/closes in/g) || []).length, 2);
});

test('My Bids: empty state', () => {
  const html = renderToStaticMarkup(h(MyBidsList, { bids: [] }));
  assert.match(html, /You have not bid on any tender yet/);
});
