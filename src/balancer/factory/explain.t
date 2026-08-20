This is the Factory Design Pattern.

It is used to keep object instantiation logic clean in dynamic systems. When the proxy starts, it reads the load-balancing strategy from the configuration file (config.yaml), such as round-robin or least-connections. The createLoadBalancer factory method parses the configuration, creates the appropriate Load Balancer object with the required parameters, and provides it to the server core.

