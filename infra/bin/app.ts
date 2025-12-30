#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { StagingStack } from '../lib/staging-stack';

const app = new cdk.App();

new StagingStack(app, 'LizDmsStagingStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-2',
  },
});

