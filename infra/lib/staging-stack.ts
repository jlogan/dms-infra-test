import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';

interface StagingStackProps extends cdk.StackProps {
  vpcCidr?: string;
  publicSubnetMask?: number;
  privateSubnetMask?: number;
  maxAzs?: number;
}

export class StagingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: StagingStackProps) {
    super(scope, id, props);

     //  Configurable Settings
    const vpcCidr = props?.vpcCidr ?? '10.0.0.0/16';
    const publicSubnetMask = props?.publicSubnetMask ?? 24;
    const privateSubnetMask = props?.privateSubnetMask ?? 24;
    const maxAzs = props?.maxAzs ?? 2;

      // VPC
    const vpc = new ec2.Vpc(this, 'Vpc', {
      cidr: vpcCidr,
      maxAzs,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: publicSubnetMask,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
          cidrMask: privateSubnetMask,
        },
      ],
    });

      // S3 Buckets
    const docsBucket = new s3.Bucket(this, 'DocsBucket', {
      bucketName: 'lizdms-staging-docs',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const outputsBucket = new s3.Bucket(this, 'OutputsBucket', {
      bucketName: 'lizdms-staging-outputs',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

      // SQS + DLQ
    const dlq = new sqs.Queue(this, 'ProcessingDLQ', {
      queueName: 'lizdms-staging-processing-dlq',
    });

    const queue = new sqs.Queue(this, 'ProcessingQueue', {
      queueName: 'lizdms-staging-processing',
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

      // ECS Cluster
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: 'lizdms-staging-cluster',
    });

      // Task Definition
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
    });

    taskDef.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject', 'sqs:SendMessage'],
        resources: ['*'],
      })
    );

      // ECR Repository
    const repo = ecr.Repository.fromRepositoryName(
      this,
      'ApiRepository',
      'lizdms-api'
    );

      // Container
    const container = taskDef.addContainer('ApiContainer', {
      image: ecs.ContainerImage.fromEcrRepository(repo),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'lizdms',
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
      environment: {
        DOCS_BUCKET: docsBucket.bucketName,
        OUTPUTS_BUCKET: outputsBucket.bucketName,
        QUEUE_URL: queue.queueUrl,
        AWS_REGION: this.region,
      },
    });

    container.addPortMappings({
      containerPort: 3000,
    });
	
      // ECS Service
    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: false,
    });

      // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc,
      internetFacing: true,
    });

      // ACM Certificate (us-east-2)
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      'AlbCertificate',
      'arn:aws:acm:us-east-2:502826260777:certificate/38022fb5-d579-401b-8b62-90c47bb6c2af'
    );

      // HTTPS Listener (443)
    const httpsListener = alb.addListener('HttpsListener', {
      port: 443,
      certificates: [certificate],
      open: true,
    });

    httpsListener.addTargets('EcsTargets', {
      port: 80,
      targets: [service],
      healthCheck: {
        path: '/',
        healthyHttpCodes: '200',
      },
    });

      // HTTP → HTTPS Redirect
    alb.addListener('HttpRedirect', {
      port: 80,
      open: true,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

      // Outputs
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: alb.loadBalancerDnsName,
    });

    new cdk.CfnOutput(this, 'VpcCidr', {
      value: vpc.vpcCidrBlock,
    });

    new cdk.CfnOutput(this, 'PublicSubnets', {
      value: vpc.publicSubnets.map(s => s.subnetId).join(','),
    });

    new cdk.CfnOutput(this, 'PrivateSubnets', {
      value: vpc.privateSubnets.map(s => s.subnetId).join(','),
    });
  }
}

