FROM --platform=$BUILDPLATFORM node:20 as builder
ARG TARGETOS
ARG TARGETARCH
WORKDIR /usr/app
RUN curl -o terraform.zip https://releases.hashicorp.com/terraform/1.8.4/terraform_1.8.4_${TARGETOS}_${TARGETARCH}.zip && \
    unzip terraform.zip
COPY package.json package-lock.json .
RUN npm install
COPY *.ts .
RUN npm run build

FROM public.ecr.aws/lambda/nodejs:20
WORKDIR ${LAMBDA_TASK_ROOT}
COPY --from=builder /usr/app/dist/* /usr/app/terraform ./
CMD ["index.handler"]
