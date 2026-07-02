// Router orchestrator for /api/tasks.
//
// Mount order matters: routers that own static paths (e.g. /labels/manage,
// /backlog, /search, /available-sprints, /carry-forward, /lookup/...) must
// be registered before the generic CRUD router which owns /:id/* patterns,
// otherwise Express may match a static segment as an :id parameter.
//
// All sub-routers are wired under '/' so the original endpoint URLs remain
// unchanged (e.g. POST /api/tasks/backlog, GET /api/tasks/:id/detail).

import express from "express";
const { requireTenant } = require('../../middleware/tenant');

const metaRouter = require('./meta');
const labelsRouter = require('./labels');
const backlogRouter = require('./backlog');
const searchRouter = require('./search');
const sprintsRouter = require('./sprints');
const carryForwardRouter = require('./carryForward');
const commentsRouter = require('./comments');
const detailRouter = require('./detail');
const dependenciesRouter = require('./dependencies');
const criteriaRouter = require('./criteria');
const blockersRouter = require('./blockers');
const hierarchyRouter = require('./hierarchy');
const gitRouter = require('./git');
const crudRouter = require('./crud');

const router = express.Router();
router.use(requireTenant);

// Static-path-first sub-routers
router.use('/', metaRouter);          // /assignable-users, /labels (GET)
router.use('/', labelsRouter);        // /labels/manage, /labels (POST), /labels/:id
router.use('/', backlogRouter);       // /backlog (GET/POST), /:id/schedule, /:id/unschedule
router.use('/', searchRouter);        // /search, /lookup/quicksearch
// Sprint-related task routes are part of the Agile feature bundle — same gate
// as /api/sprints and /api/agile. The gate is applied PER-ROUTE inside the
// sub-router (not on the mount, which matches every /api/tasks path) so a
// tenant with "Agile & Sprints" disabled still has full access to backlog,
// CRUD, comments, etc.
router.use('/', sprintsRouter);       // /available-sprints, /:id/assign-sprint (agile-gated)
router.use('/', carryForwardRouter);  // /carry-forward (daily planner — NOT agile-gated)

// :id-based sub-routers
router.use('/', commentsRouter);      // /:id/comments
router.use('/', detailRouter);        // /:id/detail, /:id/history
router.use('/', dependenciesRouter);  // /:id/dependencies
router.use('/', criteriaRouter);      // /:id/acceptance-criteria
router.use('/', blockersRouter);      // /:id/block
router.use('/', hierarchyRouter);     // /:id/children, /:id/parent
router.use('/', gitRouter);           // /:id/git

// Generic CRUD last (owns GET /, POST /, PUT /:id, DELETE /:id, PATCH /:id/status)
router.use('/', crudRouter);

export = router;