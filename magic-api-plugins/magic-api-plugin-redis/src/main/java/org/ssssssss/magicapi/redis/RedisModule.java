package org.ssssssss.magicapi.redis;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.ResolvableType;
import org.springframework.dao.InvalidDataAccessApiUsageException;
import org.springframework.data.redis.connection.DefaultStringRedisConnection;
import org.springframework.data.redis.connection.RedisConnection;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.connection.RedisPipelineException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.util.Pair;
import org.springframework.util.ClassUtils;
import org.springframework.util.ReflectionUtils;
import org.ssssssss.magicapi.core.annotation.MagicModule;
import org.ssssssss.script.functions.DynamicMethod;
import org.ssssssss.script.reflection.JavaReflection;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.*;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

/**
 * redis模块
 *
 * @author mxd
 */
@MagicModule("redis")
public class RedisModule implements DynamicMethod {

	private final StringRedisTemplate redisTemplate;

	private final boolean isRedisson;

    private final Logger log = LoggerFactory.getLogger(RedisModule.class);

	public RedisModule(RedisConnectionFactory connectionFactory) {
		this.redisTemplate = new StringRedisTemplate(connectionFactory);
		this.isRedisson = Objects.equals("org.redisson.spring.data.connection.RedissonConnectionFactory", this.redisTemplate.getConnectionFactory().getClass().getName());
	}

	/**
	 * 序列化
	 */
	private byte[] serializer(Object value) {
		if (value == null || value instanceof String) {
			return redisTemplate.getStringSerializer().serialize((String) value);
		}
		return serializer(value.toString());
	}

	private Object serializerForRedisson(Object value){
		if(value == null || JavaReflection.isPrimitiveAssignableFrom(value.getClass(), value.getClass())){
			return value;
		}
		return serializer(value.toString());
	}

	/**
	 * 反序列化
	 */
	@SuppressWarnings("unchecked")
	private Object deserialize(Object value) {
		if (value != null) {
			if (value instanceof byte[]) {
				return this.redisTemplate.getStringSerializer().deserialize((byte[]) value);
			}
			if (value instanceof Collection) {
				Collection<Object> valueList = (Collection<Object>) value;
				List<Object> resultList = new ArrayList<>(valueList.size());
				for (Object val : valueList) {
					resultList.add(deserialize(val));
				}
				return resultList;
			}
			if (value instanceof Map) {
				Map<Object, Object> map = (Map<Object, Object>) value;
				LinkedHashMap<Object, Object> newMap = new LinkedHashMap<>(map.size());
				map.forEach((key, val) -> newMap.put(deserialize(key), deserialize(val)));
				return newMap;
			}
		}
		return value;
	}

	/**
	 * 执行命令
	 *
	 * @param methodName 命令名称
	 * @param parameters 命令参数
	 */
	@Override
	public Object execute(String methodName, List<Object> parameters) {
		return this.redisTemplate.execute(connection -> {
			Object result;
			if(isRedisson){
				result = executeForRedisson(((DefaultStringRedisConnection) connection).getDelegate(), methodName, parameters);
			} else {
				byte[][] params = new byte[parameters.size()][];
				for (int i = 0; i < params.length; i++) {
					params[i] = serializer(parameters.get(i));
				}
				result = connection.execute(methodName, params);
			}
			return deserialize(result);
		}, isRedisson || this.redisTemplate.isExposeConnection());
	}

	private Object executeForRedisson(RedisConnection connection, String command, List<Object> parameters) {
		Method[] methods = connection.getClass().getDeclaredMethods();
		for (Method method : methods) {
			if (method.getName().equalsIgnoreCase(command) && Modifier.isPublic(method.getModifiers()) && method.getParameterTypes().length == parameters.size()) {
				try {
					Object ret = this.execute(connection, method, parameters);
					if (ret instanceof String) {
						return ((String) ret).getBytes();
					}
					return ret;
				} catch (IllegalArgumentException e) {
					if (connection.isPipelined()) {
						throw new RedisPipelineException(e);
					}

					throw new InvalidDataAccessApiUsageException(e.getMessage(), e);
				}
			}
		}
		throw new UnsupportedOperationException();
	}
	private Object execute(RedisConnection connection,Method method, List<Object> parameters){
		if (method.getParameterTypes().length > 0 && method.getParameterTypes()[0] == byte[][].class) {
			// 调用第一个参数是 Byte数组 的可变长的参数方法
			return ReflectionUtils.invokeMethod(method, connection, (Object) parameters.stream().map(this::serializer).toArray(byte[][]::new));
		} else if (parameters.isEmpty()){
			// 调用无参方法
			return ReflectionUtils.invokeMethod(method, connection);
		}
		// 数组和
		return ReflectionUtils.invokeMethod(method, connection, serializerForRedissonFix(method, parameters));
	}

    /**
     * 解决复杂类型的参数转换支持
     *
     * @param method
     * @param parameters
     * @return
     */
    private Object[] serializerForRedissonFix(Method method, List<Object> parameters) {
        Class<?>[] parameterTypes = method.getParameterTypes();
        if (parameterTypes.length != parameters.size()) {
            log.error("Redisson方法参数不正确,methodName:{},parameterTypes:[{}]", getMethodSignature(method, parameterTypes), parameters.stream().map(i -> i.getClass().getName()).collect(Collectors.joining(",")));
            throw new IllegalArgumentException("Redisson 调用方法参数不正确");
        }
        return IntStream.range(0, method.getParameterCount())
                .mapToObj(index -> Pair.of(index, parameterTypes[index]))
                .map(indexedObj -> {
                    Integer index = indexedObj.getFirst();
                    Class<?> methodParamType = indexedObj.getSecond();
                    Object o = parameters.get(index);
                    if (methodParamType == byte[][].class) {
                        if (o instanceof Collection) {
                            Collection<?> collection = (Collection<?>) o;
                            return collection.stream().map(this::serializer).toArray(byte[][]::new);
                        } else {
                            return new byte[][]{serializer(o)};
                        }
                    }
                    if (methodParamType == byte[].class) {
                        return serializer(o);
                    }
                    if (ClassUtils.isPrimitiveOrWrapper(methodParamType)) {
                        return o;
                    }
                    if (ResolvableType.forClass(methodParamType).isAssignableFrom(ResolvableType.forClassWithGenerics(Map.class, byte[].class, byte[].class))) {
                        if (o instanceof Map) {
                            return Optional.of(o)
                                    .map(i -> ((Map<?, ?>) i))
                                    .map(map -> map.entrySet()
                                            .stream()
                                            .map(entry -> new AbstractMap.SimpleEntry<>(serializer(entry.getKey()), serializer(entry.getValue())))
                                            .collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue, (a, b) -> a, LinkedHashMap::new))
                                    )
                                    .orElseThrow(() -> new IllegalArgumentException("输入参数为空"));
                        } else {
                            log.error("Redisson方法参数类型不正确,supposed:{},input:[{}]", "Map<byte[],byte[]>", o.getClass().getName());
                            throw new IllegalArgumentException("参数类型不符合");
                        }
                    }
                    log.error("Redisson方法参数类型未支持序列化,supposed:{},input:{}", methodParamType.getName(), o.getClass().getName());
                    throw new UnsupportedOperationException("Redisson 方法调用的参数类型 暂未支持");
                })
                .toArray();
    }

    public String getMethodSignature(Method method, Class<?>[] parameterTypes) {
        String className = method.getDeclaringClass().getName();
        String methodName = method.getName();
        // 获取参数类型并转换为逗号分隔的字符串
        String params = Arrays.stream(parameterTypes)
                .map(Class::getSimpleName) // 或者用 getName() 获取全路径类型
                .collect(Collectors.joining(", "));

        return String.format("%s.%s(%s)", className, methodName, params);
    }

}
